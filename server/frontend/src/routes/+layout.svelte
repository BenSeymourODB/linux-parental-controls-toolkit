<script lang="ts">
  // Svelte 5 runes: child routes are passed in via the `children` snippet.
  let { children } = $props();
</script>

{@render children()}
