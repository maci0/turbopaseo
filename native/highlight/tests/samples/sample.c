#include <stdio.h>
#define MAX 10
typedef struct { int x; float y; } point;
int main(int argc, char **argv) {
  /* block comment */
  for (int i = 0; i < MAX; i++) printf("%d\n", i);
  return 0;
}
