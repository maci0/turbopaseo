/*
 * Pseudo-terminal shim for scriptc's FFI, replacing node-pty on Linux and
 * macOS. See README.md for the TypeScript side and the event contract.
 *
 * Each spawned child owns one slot. Two detached threads serve a slot:
 *   waiter: blocks in waitid() until the child exits, then reaps it.
 *   io:     polls the master and a wake pipe, delivers output, flushes
 *           queued input, and after the child exits drains what is left,
 *           delivers the exit event and closes the master.
 * All slot state is guarded by g_mu. Events go through the registered
 * callback only while the slot is not released, so after pty_release
 * returns native code never touches the closure again. The slot is freed by
 * whichever of release, io and waiter finishes last.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <util.h>
#else
#include <pty.h>
#include <linux/close_range.h>
#endif

extern char **environ;

#define PTY_MAX_SLOTS 256
#define PTY_READ_CHUNK 65536
#define UTF8_MAX_CARRY 3
#define FALLBACK_MAX_FD 65536

enum { PTY_EVENT_DATA = 0, PTY_EVENT_EXIT = 1 };

/* Exit code reported when the child was reaped by someone else (ECHILD). */
#define PTY_EXIT_UNKNOWN (-1)

typedef void (*pty_event_cb)(int32_t kind, int32_t code, int32_t signal,
                             const uint8_t *data, size_t len, void *ctx);

struct pty_slot {
  int in_use;
  pid_t pid;
  int master;  /* -1 once the io thread closed it */
  int wake[2]; /* io thread wake pipe, both ends non-blocking */
  int started;
  int child_gone; /* waiter is done with pid; kill() must not use it */
  int exited;     /* exit_code/exit_signal are final */
  int32_t exit_code;
  int32_t exit_signal;
  int released;
  int io_done;
  int waiter_done;
  pty_event_cb cb;
  void *ctx;
  uint8_t *wq; /* pending input not yet accepted by the master */
  size_t wq_len;
  size_t wq_cap;
};

static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static struct pty_slot g_slots[PTY_MAX_SLOTS];

static int set_cloexec_nonblock(int fd, int nonblock) {
  int fl = fcntl(fd, F_GETFD);
  if (fl < 0 || fcntl(fd, F_SETFD, fl | FD_CLOEXEC) < 0)
    return -1;
  if (nonblock) {
    fl = fcntl(fd, F_GETFL);
    if (fl < 0 || fcntl(fd, F_SETFL, fl | O_NONBLOCK) < 0)
      return -1;
  }
  return 0;
}

static int make_pipe(int fds[2], int nonblock) {
#if defined(__linux__)
  return pipe2(fds, O_CLOEXEC | (nonblock ? O_NONBLOCK : 0));
#else
  if (pipe(fds) < 0)
    return -1;
  if (set_cloexec_nonblock(fds[0], nonblock) < 0 ||
      set_cloexec_nonblock(fds[1], nonblock) < 0) {
    int saved = errno;
    close(fds[0]);
    close(fds[1]);
    errno = saved;
    return -1;
  }
  return 0;
#endif
}

static struct pty_slot *slot_get(int32_t handle) {
  if (handle < 0 || handle >= PTY_MAX_SLOTS || !g_slots[handle].in_use)
    return NULL;
  return &g_slots[handle];
}

/* Caller holds g_mu. */
static void slot_maybe_free(struct pty_slot *s) {
  if (!(s->released && (!s->started || (s->io_done && s->waiter_done))))
    return;
  if (s->master >= 0)
    close(s->master);
  close(s->wake[0]);
  close(s->wake[1]);
  free(s->wq);
  memset(s, 0, sizeof *s);
}

static void wake_io(struct pty_slot *s) {
  ssize_t r;
  do {
    r = write(s->wake[1], "w", 1);
  } while (r < 0 && errno == EINTR);
  /* EAGAIN: the pipe already holds an unread wake byte. */
}

/* Split NUL-terminated entries out of a borrowed span into a NULL-terminated
 * vector. Both the vector and the strings are one allocation. */
static char **split_nul_list(const uint8_t *data, size_t len) {
  size_t count = 0;
  for (size_t i = 0; i < len; i++)
    if (data[i] == 0)
      count++;
  if (len > 0 && data[len - 1] != 0)
    count++;
  size_t vec_bytes = (count + 1) * sizeof(char *);
  char **vec = malloc(vec_bytes + len + 1);
  if (!vec)
    return NULL;
  char *strs = (char *)vec + vec_bytes;
  if (len > 0)
    memcpy(strs, data, len);
  strs[len] = 0;
  size_t n = 0;
  char *p = strs;
  while (n < count) {
    vec[n++] = p;
    p += strlen(p) + 1;
  }
  vec[n] = NULL;
  return vec;
}

static char *copy_span(const uint8_t *data, size_t len) {
  char *s = malloc(len + 1);
  if (!s)
    return NULL;
  if (len > 0)
    memcpy(s, data, len);
  s[len] = 0;
  return s;
}

/* Termios settings matching node-pty's src/unix/pty.cc. */
static void default_termios(struct termios *t) {
  memset(t, 0, sizeof *t);
  t->c_iflag = ICRNL | IXON | IXANY | IMAXBEL | BRKINT;
#if defined(IUTF8)
  t->c_iflag |= IUTF8;
#endif
  t->c_oflag = OPOST | ONLCR;
  t->c_cflag = CREAD | CS8 | HUPCL;
  t->c_lflag = ICANON | ISIG | IEXTEN | ECHO | ECHOE | ECHOK | ECHOKE | ECHOCTL;
  t->c_cc[VEOF] = 4;
  t->c_cc[VEOL] = 0xff;
  t->c_cc[VEOL2] = 0xff;
  t->c_cc[VERASE] = 0x7f;
  t->c_cc[VWERASE] = 23;
  t->c_cc[VKILL] = 21;
  t->c_cc[VREPRINT] = 18;
  t->c_cc[VINTR] = 3;
  t->c_cc[VQUIT] = 0x1c;
  t->c_cc[VSUSP] = 26;
  t->c_cc[VSTART] = 17;
  t->c_cc[VSTOP] = 19;
  t->c_cc[VLNEXT] = 22;
  t->c_cc[VDISCARD] = 15;
  t->c_cc[VMIN] = 1;
  t->c_cc[VTIME] = 0;
#if defined(VDSUSP)
  t->c_cc[VDSUSP] = 25;
#endif
#if defined(VSTATUS)
  t->c_cc[VSTATUS] = 20;
#endif
  cfsetispeed(t, B38400);
  cfsetospeed(t, B38400);
}

/* Child side between fork and exec: async-signal-safe calls only. */
static void child_exec(const char *file, char **argv, char **envp,
                       const char *cwd, int err_fd) {
  struct sigaction dfl;
  memset(&dfl, 0, sizeof dfl);
  dfl.sa_handler = SIG_DFL;
  for (int sig = 1; sig < NSIG; sig++)
    sigaction(sig, &dfl, NULL); /* fails harmlessly for SIGKILL/SIGSTOP */
  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);

  /* Keep inherited descriptors out of the child. err_fd is already
   * close-on-exec, so it closes on a successful exec. */
#if defined(__linux__) && defined(SYS_close_range)
  if (syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_CLOEXEC) != 0)
#endif
  {
    long max = sysconf(_SC_OPEN_MAX);
    if (max < 0 || max > FALLBACK_MAX_FD)
      max = FALLBACK_MAX_FD;
    for (int fd = 3; fd < max; fd++) {
      int fl = fcntl(fd, F_GETFD);
      if (fl >= 0)
        fcntl(fd, F_SETFD, fl | FD_CLOEXEC);
    }
  }

  int err = 0;
  if (cwd[0] != 0 && chdir(cwd) < 0) {
    err = errno;
  } else {
    environ = envp;
    execvp(file, argv);
    err = errno;
  }
  ssize_t r;
  do {
    r = write(err_fd, &err, sizeof err);
  } while (r < 0 && errno == EINTR);
  _exit(127);
}

/*
 * Spawn file with argv and env (each a list of NUL-terminated entries), in
 * cwd (empty keeps the current directory), on a cols x rows terminal.
 * Returns a handle >= 0, or -errno. Exec and chdir failures in the child are
 * reported here as -errno; that child is reaped before returning.
 */
int32_t pty_spawn(const uint8_t *file, size_t file_len, const uint8_t *argv_blob,
                  size_t argv_len, const uint8_t *env_blob, size_t env_len,
                  const uint8_t *cwd_blob, size_t cwd_len, uint32_t cols,
                  uint32_t rows) {
  char *file_s = copy_span(file, file_len);
  char *cwd_s = copy_span(cwd_blob, cwd_len);
  char **argv = split_nul_list(argv_blob, argv_len);
  char **envp = split_nul_list(env_blob, env_len);
  int32_t result = -ENOMEM;
  int err_pipe[2] = {-1, -1};
  int wake[2] = {-1, -1};
  int master = -1;
  pid_t pid = -1;
  struct pty_slot *slot = NULL;
  int32_t handle = -1;

  if (!file_s || !cwd_s || !argv || !envp)
    goto out;
  if (argv[0] == NULL) {
    result = -EINVAL;
    goto out;
  }

  pthread_mutex_lock(&g_mu);
  for (int i = 0; i < PTY_MAX_SLOTS; i++) {
    if (!g_slots[i].in_use) {
      handle = i;
      slot = &g_slots[i];
      slot->in_use = 1; /* reserved; fields are filled below */
      slot->master = -1;
      slot->wake[0] = slot->wake[1] = -1;
      break;
    }
  }
  pthread_mutex_unlock(&g_mu);
  if (!slot) {
    result = -EMFILE;
    goto out;
  }

  if (make_pipe(err_pipe, 0) < 0 || make_pipe(wake, 1) < 0) {
    result = -errno;
    goto fail;
  }

  struct termios term;
  default_termios(&term);
  struct winsize ws = {.ws_row = (unsigned short)rows,
                       .ws_col = (unsigned short)cols};

  /* Block every signal across fork so the child cannot run the runtime's
   * handlers before it resets them. */
  sigset_t all, old;
  sigfillset(&all);
  pthread_sigmask(SIG_SETMASK, &all, &old);
  pid = forkpty(&master, NULL, &term, &ws);
  if (pid == 0)
    child_exec(file_s, argv, envp, cwd_s, err_pipe[1]);
  int fork_errno = errno;
  pthread_sigmask(SIG_SETMASK, &old, NULL);
  if (pid < 0) {
    result = -fork_errno;
    goto fail;
  }

  close(err_pipe[1]);
  err_pipe[1] = -1;
  int child_err = 0;
  ssize_t r;
  do {
    r = read(err_pipe[0], &child_err, sizeof child_err);
  } while (r < 0 && errno == EINTR);
  if (r == (ssize_t)sizeof child_err) {
    int st;
    while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {
    }
    result = -child_err;
    goto fail;
  }

  if (set_cloexec_nonblock(master, 1) < 0) {
    result = -errno;
    kill(pid, SIGKILL);
    int st;
    while (waitpid(pid, &st, 0) < 0 && errno == EINTR) {
    }
    goto fail;
  }

  pthread_mutex_lock(&g_mu);
  slot->pid = pid;
  slot->master = master;
  slot->wake[0] = wake[0];
  slot->wake[1] = wake[1];
  pthread_mutex_unlock(&g_mu);
  master = -1;
  wake[0] = wake[1] = -1;
  result = handle;
  slot = NULL;

fail:
  if (master >= 0)
    close(master);
  if (wake[0] >= 0)
    close(wake[0]);
  if (wake[1] >= 0)
    close(wake[1]);
  if (slot) {
    pthread_mutex_lock(&g_mu);
    memset(slot, 0, sizeof *slot);
    pthread_mutex_unlock(&g_mu);
  }
out:
  if (err_pipe[0] >= 0)
    close(err_pipe[0]);
  if (err_pipe[1] >= 0)
    close(err_pipe[1]);
  free(file_s);
  free(cwd_s);
  free(argv);
  free(envp);
  return result;
}

/* Length of the prefix of buf that ends on a UTF-8 sequence boundary. At most
 * UTF8_MAX_CARRY trailing bytes of an incomplete sequence are held back;
 * malformed input is passed through for the decoder to replace. */
static size_t utf8_boundary(const uint8_t *buf, size_t n) {
  size_t back = 0;
  while (back < n && back < UTF8_MAX_CARRY + 1) {
    uint8_t b = buf[n - 1 - back];
    if ((b & 0xC0) == 0x80) {
      back++;
      continue;
    }
    size_t need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : b >= 0xC0 ? 2 : 1;
    if (b >= 0xF8)
      need = 1;
    return back + 1 < need ? n - 1 - back : n;
  }
  return n;
}

/* Deliver one event unless the slot was released. Caller holds no lock. */
static void emit(struct pty_slot *s, int32_t kind, int32_t code, int32_t sig,
                 const uint8_t *data, size_t len) {
  pthread_mutex_lock(&g_mu);
  if (!s->released)
    s->cb(kind, code, sig, data, len, s->ctx);
  pthread_mutex_unlock(&g_mu);
}

/* Caller holds g_mu. Returns 0, or -1 when the master refuses input. */
static int flush_queue_locked(struct pty_slot *s) {
  while (s->wq_len > 0) {
    ssize_t w = write(s->master, s->wq, s->wq_len);
    if (w > 0) {
      memmove(s->wq, s->wq + w, s->wq_len - (size_t)w);
      s->wq_len -= (size_t)w;
    } else if (w < 0 && errno == EINTR) {
      continue;
    } else if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return 0;
    } else {
      s->wq_len = 0; /* EIO: the slave side is gone, input has no reader */
      return -1;
    }
  }
  return 0;
}

/* Read everything currently available. Returns 1 when the master reached
 * EOF or EIO, else 0. carry/carry_len hold an incomplete UTF-8 tail. */
static int read_available(struct pty_slot *s, int master, uint8_t *buf,
                          size_t *carry_len) {
  for (;;) {
    ssize_t n = read(master, buf + *carry_len, PTY_READ_CHUNK);
    if (n < 0 && errno == EINTR)
      continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
      return 0;
    if (n <= 0)
      return 1; /* 0: EOF; EIO on Linux once every slave fd is closed */
    size_t total = *carry_len + (size_t)n;
    size_t cut = utf8_boundary(buf, total);
    if (cut > 0)
      emit(s, PTY_EVENT_DATA, 0, 0, buf, cut);
    memmove(buf, buf + cut, total - cut);
    *carry_len = total - cut;
  }
}

static void *io_thread(void *arg) {
  struct pty_slot *s = arg;
  uint8_t *buf = malloc(PTY_READ_CHUNK + UTF8_MAX_CARRY);
  size_t carry_len = 0;
  int master_dead = buf == NULL;

  pthread_mutex_lock(&g_mu);
  int master = s->master;
  int wake_fd = s->wake[0];
  pthread_mutex_unlock(&g_mu);

  for (;;) {
    pthread_mutex_lock(&g_mu);
    int exited = s->exited;
    int released = s->released;
    int want_out = s->wq_len > 0 && !master_dead;
    pthread_mutex_unlock(&g_mu);
    if (released)
      break;
    if (exited) {
      if (!master_dead)
        read_available(s, master, buf, &carry_len);
      break;
    }

    struct pollfd pfd[2] = {
        {.fd = wake_fd, .events = POLLIN},
        {.fd = master_dead ? -1 : master,
         .events = (short)(POLLIN | (want_out ? POLLOUT : 0))},
    };
    int pr = poll(pfd, 2, -1);
    if (pr < 0) {
      if (errno == EINTR)
        continue;
      break;
    }
    if (pfd[0].revents & POLLIN) {
      char drain[64];
      while (read(wake_fd, drain, sizeof drain) > 0) {
      }
    }
    if (!master_dead && (pfd[1].revents & (POLLIN | POLLHUP | POLLERR)))
      master_dead = read_available(s, master, buf, &carry_len);
    if (!master_dead && (pfd[1].revents & POLLOUT)) {
      pthread_mutex_lock(&g_mu);
      if (flush_queue_locked(s) < 0)
        master_dead = 1;
      pthread_mutex_unlock(&g_mu);
    }
  }

  if (carry_len > 0)
    emit(s, PTY_EVENT_DATA, 0, 0, buf, carry_len);
  free(buf);

  pthread_mutex_lock(&g_mu);
  int32_t code = s->exit_code, sig = s->exit_signal;
  int exited = s->exited;
  pthread_mutex_unlock(&g_mu);
  if (exited)
    emit(s, PTY_EVENT_EXIT, code, sig, NULL, 0);

  pthread_mutex_lock(&g_mu);
  close(s->master); /* hangs up the session if the child is still alive */
  s->master = -1;
  s->wq_len = 0;
  s->io_done = 1;
  slot_maybe_free(s);
  pthread_mutex_unlock(&g_mu);
  return NULL;
}

static void *waiter_thread(void *arg) {
  struct pty_slot *s = arg;
  pthread_mutex_lock(&g_mu);
  pid_t pid = s->pid;
  pthread_mutex_unlock(&g_mu);

  /* WNOWAIT leaves the zombie in place, so pty_kill can never signal a
   * recycled pid: child_gone is set before the pid is released. */
  siginfo_t si;
  int r;
  do {
    memset(&si, 0, sizeof si);
    r = waitid(P_PID, (id_t)pid, &si, WEXITED | WNOWAIT);
  } while (r < 0 && errno == EINTR);

  int32_t code = PTY_EXIT_UNKNOWN, sig = 0;
  pthread_mutex_lock(&g_mu);
  s->child_gone = 1;
  pthread_mutex_unlock(&g_mu);
  if (r == 0) {
    int st = 0;
    pid_t w;
    do {
      w = waitpid(pid, &st, 0);
    } while (w < 0 && errno == EINTR);
    if (w == pid && WIFEXITED(st)) {
      code = WEXITSTATUS(st);
    } else if (w == pid && WIFSIGNALED(st)) {
      code = 0;
      sig = WTERMSIG(st);
    }
  }

  pthread_mutex_lock(&g_mu);
  s->exit_code = code;
  s->exit_signal = sig;
  s->exited = 1;
  wake_io(s);
  s->waiter_done = 1;
  slot_maybe_free(s);
  pthread_mutex_unlock(&g_mu);
  return NULL;
}

/*
 * Register the event callback and start the threads. Events:
 *   PTY_EVENT_DATA (0): data/len is output, split on UTF-8 boundaries.
 *   PTY_EVENT_EXIT (1): code and signal of the child, delivered once, after
 *                       all output; the last event of the handle.
 * Returns 0 or -errno. On failure no event is ever delivered.
 */
int32_t pty_start(int32_t handle, pty_event_cb cb, void *ctx) {
  pthread_mutex_lock(&g_mu);
  struct pty_slot *s = slot_get(handle);
  if (!s || s->started || s->released) {
    pthread_mutex_unlock(&g_mu);
    return -EBADF;
  }
  s->cb = cb;
  s->ctx = ctx;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_t waiter, io;
  int err = pthread_create(&waiter, &attr, waiter_thread, s);
  if (err == 0) {
    err = pthread_create(&io, &attr, io_thread, s);
    if (err != 0) {
      /* Without an io thread nothing reads the master; kill the child and
       * let the waiter reap it. Count io as done so the slot can be freed. */
      kill(s->pid, SIGKILL);
      s->io_done = 1;
    }
    s->started = 1;
  }
  pthread_attr_destroy(&attr);
  pthread_mutex_unlock(&g_mu);
  return -err;
}

/*
 * Stop event delivery for handle. After this returns the callback is never
 * invoked again. If the child is still running, the io thread closes the
 * master, which sends SIGHUP to the child's session; the waiter still reaps it.
 */
void pty_release(int32_t handle, pty_event_cb cb, void *ctx) {
  (void)cb;
  (void)ctx;
  pthread_mutex_lock(&g_mu);
  struct pty_slot *s = slot_get(handle);
  if (s && !s->released) {
    s->released = 1;
    if (s->started && !s->io_done)
      wake_io(s);
    slot_maybe_free(s);
  }
  pthread_mutex_unlock(&g_mu);
}

/*
 * Queue data for the child. Returns 0, -EBADF for an unknown handle, -EIO
 * once the master no longer accepts input (child gone), or -ENOMEM.
 */
int32_t pty_write(int32_t handle, const uint8_t *data, size_t len) {
  pthread_mutex_lock(&g_mu);
  struct pty_slot *s = slot_get(handle);
  int32_t rc = 0;
  if (!s || s->released) {
    rc = -EBADF;
  } else if (s->master < 0 || s->exited) {
    rc = -EIO;
  } else if (len > 0) {
    if (s->wq_len + len > s->wq_cap) {
      size_t cap = s->wq_cap ? s->wq_cap : 4096;
      while (cap < s->wq_len + len)
        cap *= 2;
      uint8_t *grown = realloc(s->wq, cap);
      if (!grown) {
        pthread_mutex_unlock(&g_mu);
        return -ENOMEM;
      }
      s->wq = grown;
      s->wq_cap = cap;
    }
    memcpy(s->wq + s->wq_len, data, len);
    s->wq_len += len;
    if (flush_queue_locked(s) < 0)
      rc = -EIO;
    else if (s->wq_len > 0)
      wake_io(s); /* io thread waits for POLLOUT and flushes the rest */
  }
  pthread_mutex_unlock(&g_mu);
  return rc;
}

/* Set the window size. Returns 0, -EBADF, -EIO after the master closed, or
 * the ioctl's -errno. The kernel sends SIGWINCH to the foreground group. */
int32_t pty_resize(int32_t handle, uint32_t cols, uint32_t rows) {
  pthread_mutex_lock(&g_mu);
  struct pty_slot *s = slot_get(handle);
  int32_t rc;
  if (!s || s->released) {
    rc = -EBADF;
  } else if (s->master < 0) {
    rc = -EIO;
  } else {
    struct winsize ws = {.ws_row = (unsigned short)rows,
                         .ws_col = (unsigned short)cols};
    rc = ioctl(s->master, TIOCSWINSZ, &ws) < 0 ? -errno : 0;
  }
  pthread_mutex_unlock(&g_mu);
  return rc;
}

/* Send sig to the child. Returns 0, -EBADF, -ESRCH once it was reaped, or
 * kill()'s -errno. */
int32_t pty_kill(int32_t handle, int32_t sig) {
  pthread_mutex_lock(&g_mu);
  struct pty_slot *s = slot_get(handle);
  int32_t rc;
  if (!s || s->released)
    rc = -EBADF;
  else if (s->child_gone)
    rc = -ESRCH;
  else
    rc = kill(s->pid, sig) < 0 ? -errno : 0;
  pthread_mutex_unlock(&g_mu);
  return rc;
}

int32_t pty_pid(int32_t handle) {
  pthread_mutex_lock(&g_mu);
  struct pty_slot *s = slot_get(handle);
  int32_t pid = s ? (int32_t)s->pid : -EBADF;
  pthread_mutex_unlock(&g_mu);
  return pid;
}

static const struct {
  const char *name;
  int num;
} k_signals[] = {
    {"SIGHUP", SIGHUP},   {"SIGINT", SIGINT},     {"SIGQUIT", SIGQUIT},
    {"SIGILL", SIGILL},   {"SIGTRAP", SIGTRAP},   {"SIGABRT", SIGABRT},
    {"SIGBUS", SIGBUS},   {"SIGFPE", SIGFPE},     {"SIGKILL", SIGKILL},
    {"SIGUSR1", SIGUSR1}, {"SIGSEGV", SIGSEGV},   {"SIGUSR2", SIGUSR2},
    {"SIGPIPE", SIGPIPE}, {"SIGALRM", SIGALRM},   {"SIGTERM", SIGTERM},
    {"SIGCHLD", SIGCHLD}, {"SIGCONT", SIGCONT},   {"SIGSTOP", SIGSTOP},
    {"SIGTSTP", SIGTSTP}, {"SIGTTIN", SIGTTIN},   {"SIGTTOU", SIGTTOU},
    {"SIGURG", SIGURG},   {"SIGXCPU", SIGXCPU},   {"SIGXFSZ", SIGXFSZ},
    {"SIGVTALRM", SIGVTALRM}, {"SIGPROF", SIGPROF}, {"SIGWINCH", SIGWINCH},
    {"SIGIO", SIGIO},     {"SIGSYS", SIGSYS},
};

/* Platform number for a signal name such as "SIGTERM", or -EINVAL. */
int32_t pty_signal_number(const uint8_t *name, size_t len) {
  for (size_t i = 0; i < sizeof k_signals / sizeof k_signals[0]; i++) {
    const char *n = k_signals[i].name;
    if (strlen(n) == len && memcmp(n, name, len) == 0)
      return k_signals[i].num;
  }
  return -EINVAL;
}

/* Copy strerror(code) into out without a terminator; returns the byte count
 * written (truncated to out_len). */
int32_t pty_strerror(int32_t code, uint8_t *out, size_t out_len) {
  char buf[256];
#if defined(__GLIBC__)
  const char *msg = strerror_r(code, buf, sizeof buf); /* GNU variant */
#else
  const char *msg = strerror_r(code, buf, sizeof buf) == 0 ? buf : "";
#endif
  size_t n = strlen(msg);
  if (n > out_len)
    n = out_len;
  memcpy(out, msg, n);
  return (int32_t)n;
}

/* Detach the calling process the way node's spawn({ detached: true }) detaches
 * a child, for a worker that scriptc's fork() started (fork has no detached or
 * fd stdio options): start a new session and process group, and point stderr
 * at log_path (appended, created 0600). Returns 0 or -errno; a failing step
 * leaves the steps before it done. */
int32_t pty_detach_session(const uint8_t *log_path, size_t len) {
  char *path = copy_span(log_path, len);
  if (!path)
    return -ENOMEM;
  int fd = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
  int err = fd < 0 ? errno : 0;
  free(path);
  if (fd < 0)
    return -err;
  if (setsid() < 0) {
    err = errno;
    close(fd);
    return -err;
  }
  int rc = dup2(fd, STDERR_FILENO) < 0 ? -errno : 0;
  close(fd);
  return rc;
}
