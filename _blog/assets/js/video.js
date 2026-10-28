(() => {
  document.querySelectorAll('[data-video-toggle]').forEach((button) => {
    const video = button.querySelector('video');
    if (!video) return;
    const sync = () => {
      const playing = !video.paused && !video.ended;
      button.setAttribute('aria-pressed', String(playing));
      button.setAttribute('aria-label', playing ? 'Поставить видео на паузу' : 'Воспроизвести видео');
    };
    let starting = false;
    button.addEventListener('click', async () => {
      if (starting || !video.paused) {
        starting = false;
        video.pause();
        sync();
        return;
      }
      starting = true;
      try { await video.play(); }
      catch { sync(); }
      finally { starting = false; }
    });
    ['play', 'pause', 'ended', 'error'].forEach((event) => video.addEventListener(event, sync));
    sync();
  });
})();