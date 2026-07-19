<!-- Destructive mini-button: first click arms it (turns pink), a second click
     within the window confirms — no dialog. -->
<script lang="ts">
  import { ICON } from './icons';

  let { title, cls = '', onconfirm }: {
    title: string;
    cls?: string;
    onconfirm: () => void;
  } = $props();

  let armed = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function click(e: MouseEvent): void {
    e.stopPropagation();
    if (armed) {
      if (timer) clearTimeout(timer);
      armed = false;
      onconfirm();
      return;
    }
    armed = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { armed = false; }, 2500);
  }
</script>

<button class="music-mini {cls}" class:is-armed={armed} type="button" {title} onclick={click}>{@html ICON.trash}</button>
