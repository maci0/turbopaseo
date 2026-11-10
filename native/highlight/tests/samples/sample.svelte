<script>
  let count = 0;
  function inc() { count += 1; }
</script>
<button on:click={inc}>Clicked {count} {count === 1 ? 'time' : 'times'}</button>
{#if count > 5}<p>Many</p>{:else}<p>Few</p>{/if}
<style>button { color: red; }</style>
