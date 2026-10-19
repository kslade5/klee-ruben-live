// Organizer dashboard: mobile menu and confirmation prompts for destructive actions.
(function () {
  var btn = document.querySelector('[data-adm-menu]'), nav = document.getElementById('adm-nav');
  if (btn && nav) btn.addEventListener('click', function () {
    var open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open)); nav.classList.toggle('is-open', open);
  });
  document.addEventListener('submit', function (e) {
    var b = e.submitter;
    if (b && b.classList.contains('abtn--danger') && !window.confirm('Are you sure? This is recorded in the audit log.')) e.preventDefault();
  });
})();
