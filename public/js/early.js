// Runs before first paint: arms the hero intro only on the home page and only when motion is welcome.
(function () {
  var d = document.documentElement;
  d.classList.add('js');
  try {
    if (location.pathname === '/' && !location.hash && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      d.classList.add('intro');
      setTimeout(function () { d.classList.add('play'); }, 2500); // safety net if the main script fails
    }
  } catch (e) {}
})();
