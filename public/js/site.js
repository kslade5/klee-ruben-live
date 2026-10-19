// Klee & Ruben Live — front-end behaviour. No frameworks, no third-party scripts.
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var bootEl = document.getElementById('boot');
  var boot = {};
  try { boot = bootEl ? JSON.parse(bootEl.textContent) : {}; } catch (e) {}

  function post(url, data) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'same-origin', body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); })
      .catch(function () { return { ok: false, message: 'Network problem. Check your connection and try again.' }; });
  }
  function track(name) { post('/api/track', { name: name }); }

  // ---------- Hero intro ----------
  var root = document.documentElement;
  if (root.classList.contains('intro')) requestAnimationFrame(function () { root.classList.add('play'); });

  // ---------- Nav ----------
  var nav = $('[data-nav]');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('is-solid', window.scrollY > 24); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    var toggle = $('[data-nav-toggle]'), menu = $('#nav-menu');
    if (toggle && menu) {
      var setOpen = function (open) { toggle.setAttribute('aria-expanded', String(open)); menu.classList.toggle('is-open', open); };
      toggle.addEventListener('click', function () { setOpen(toggle.getAttribute('aria-expanded') !== 'true'); });
      $$('a', menu).forEach(function (a) { a.addEventListener('click', function () { setOpen(false); }); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    }
  }

  // ---------- Countdown (Eastern Time handled server-side: we receive exact UTC instants) ----------
  var cds = $$('[data-countdown]');
  if (cds.length && boot.start) {
    var skew = boot.serverNow ? boot.serverNow - Date.now() : 0; // corrects a wrong device clock
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    var last = {};
    var label = $('[data-cd-label]');
    var tickCd = function () {
      var now = Date.now() + skew;
      var diff = boot.start - now;
      var msg = null;
      if (diff <= 0 && now < boot.end) msg = 'We’re live right now — come through!';
      else if (now >= boot.end) msg = 'That’s a wrap. Thank you for pulling up!';
      cds.forEach(function (cd) {
        var m = $('[data-cd-msg]', cd);
        if (msg) { cd.classList.add('is-done'); m.hidden = false; m.textContent = msg; return; }
        var s = Math.floor(diff / 1000);
        var vals = { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
        Object.keys(vals).forEach(function (k) {
          var el = $('[data-u="' + k + '"]', cd);
          var v = k === 'd' ? String(vals[k]) : pad(vals[k]);
          if (el.textContent !== v) {
            el.textContent = v;
            if (!reduced && last[k] !== undefined) { el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); }
          }
        });
        last = vals;
      });
      if (label && msg) label.textContent = now < boot.end ? 'Happening now' : 'Event ended';
      setTimeout(tickCd, 1000 - ((Date.now() + skew) % 1000) + 5);
    };
    tickCd();
  }

  // ---------- Reveals (sparing) + panel animations ----------
  var revealables = $$('[data-reveal], [data-animate]');
  if ('IntersectionObserver' in window && !reduced && revealables.length) {
    revealables.forEach(function (el) { el.classList.add('is-armed'); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-in'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -12% 0px' });
    revealables.forEach(function (el) { io.observe(el); });
  }

  // ---------- Floating light particles in the hero ----------
  var canvas = $('[data-dust]');
  if (canvas && !reduced && canvas.getContext) {
    var ctx = canvas.getContext('2d'), parts = [], visible = true, W = 0, H = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
    var size = function () { W = canvas.clientWidth; H = canvas.clientHeight; canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    size();
    window.addEventListener('resize', size);
    var count = W < 600 ? 28 : 54;
    for (var i = 0; i < count; i++) parts.push({ x: Math.random() * W, y: Math.random() * H, r: Math.random() * 1.8 + .4, v: Math.random() * .35 + .1, d: Math.random() * 6.28, gold: Math.random() < .55 });
    new IntersectionObserver(function (e) { visible = e[0].isIntersecting; if (visible) requestAnimationFrame(frame); }).observe(canvas);
    var frame = function () {
      if (!visible || document.hidden) return;
      ctx.clearRect(0, 0, W, H);
      parts.forEach(function (p) {
        p.y -= p.v; p.d += .01; p.x += Math.sin(p.d) * .25;
        if (p.y < -10) { p.y = H + 10; p.x = Math.random() * W; }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283);
        ctx.fillStyle = p.gold ? 'rgba(255,205,90,' + (.35 + p.r / 5) + ')' : 'rgba(110,225,255,' + (.3 + p.r / 5) + ')';
        ctx.fill();
      });
      requestAnimationFrame(frame);
    };
    document.addEventListener('visibilitychange', function () { if (!document.hidden && visible) requestAnimationFrame(frame); });
  }

  // ---------- Sticky mobile CTA ----------
  var sticky = $('[data-sticky-cta]'), hero = $('.hero'), rsvp = $('#rsvp');
  if (sticky && hero && rsvp && 'IntersectionObserver' in window) {
    var heroIn = true, rsvpIn = false;
    var upd = function () { sticky.classList.toggle('is-on', !heroIn && !rsvpIn); };
    new IntersectionObserver(function (e) { heroIn = e[0].isIntersecting; upd(); }).observe(hero);
    new IntersectionObserver(function (e) { rsvpIn = e[0].isIntersecting; upd(); }, { threshold: .05 }).observe(rsvp);
  }

  // ---------- Count-up for the public RSVP number ----------
  $$('[data-countup]').forEach(function (el) {
    var target = Number(el.getAttribute('data-countup'));
    if (reduced || !('IntersectionObserver' in window)) return;
    el.textContent = '0';
    var o = new IntersectionObserver(function (e) {
      if (!e[0].isIntersecting) return;
      o.disconnect();
      var t0 = performance.now();
      var step = function (t) { var k = Math.min(1, (t - t0) / 1200); el.textContent = String(Math.round(target * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
    o.observe(el);
  });

  // ---------- Form helpers ----------
  function formToObject(form) {
    var out = {}, fd = new FormData(form);
    fd.forEach(function (v, k) {
      if (k === 'interests') (out.interests = out.interests || []).push(v);
      else out[k] = v;
    });
    $$('input[type=checkbox]', form).forEach(function (c) { if (c.name !== 'interests') out[c.name] = c.checked; });
    out.interests = out.interests || [];
    return out;
  }
  function showErrors(form, errors) {
    $$('.field.has-error', form).forEach(function (f) { f.classList.remove('has-error'); });
    $$('[data-error-for]', form).forEach(function (p) { p.textContent = ''; });
    var first = null;
    Object.keys(errors || {}).forEach(function (k) {
      var p = $('[data-error-for="' + k + '"]', form);
      if (p) p.textContent = errors[k];
      var input = form.elements[k];
      if (input && input.closest) { var f = input.closest('.field'); if (f) f.classList.add('has-error'); input.setAttribute && input.setAttribute('aria-invalid', 'true'); }
      if (!first && input) first = input.length && !input.focus ? input[0] : input;
    });
    if (first && first.focus) first.focus();
  }
  function busy(btn, on) { if (!btn) return; btn.disabled = on; btn.classList.toggle('is-loading', on); }

  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
  function checkRsvp(d) {
    var e = {};
    if (!d.first_name || !d.first_name.trim()) e.first_name = 'Enter your first name.';
    if (!d.last_name || !d.last_name.trim()) e.last_name = 'Enter your last name.';
    if (!EMAIL_RE.test((d.email || '').trim())) e.email = 'Enter a valid email address, like name@example.com.';
    var digits = (d.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (digits.length !== 10) e.phone = 'Enter a 10-digit U.S. phone number.';
    if (!d.state) e.state = 'Choose your state.';
    if (!d.understands_in_person) e.understands_in_person = 'Confirm you understand this is an in-person event in Maryland.';
    if (!d.privacy_agreed) e.privacy_agreed = 'Agree to the privacy policy to register.';
    return e;
  }

  // ---------- RSVP ----------
  var rsvpForm = $('[data-rsvp-form]');
  if (rsvpForm) {
    var started = false;
    rsvpForm.addEventListener('focusin', function () { if (!started) { started = true; track('rsvp_started'); } });
    rsvpForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var data = formToObject(rsvpForm);
      var errs = checkRsvp(data);
      var formErr = $('[data-form-error]', rsvpForm);
      formErr.textContent = '';
      if (Object.keys(errs).length) { showErrors(rsvpForm, errs); formErr.textContent = 'Fix the highlighted fields.'; return; }
      showErrors(rsvpForm, {});
      var btn = $('[data-submit]', rsvpForm);
      busy(btn, true);
      post('/api/rsvp', data).then(function (r) {
        busy(btn, false);
        if (r.ok) {
          var c = $('[data-confirm]');
          c.innerHTML = r.html;
          c.hidden = false;
          rsvpForm.remove();
          var st = document.querySelector('[data-sticky-cta]'); if (st) st.remove();
          c.focus({ preventScroll: true });
          requestAnimationFrame(function () {
            var y = 0, el = c; while (el) { y += el.offsetTop; el = el.offsetParent; } // ignores the pop-in transform
            window.scrollTo({ top: y - 80, behavior: reduced ? 'auto' : 'smooth' });
          });
          initShare(c);
          return;
        }
        if (r.errors) showErrors(rsvpForm, r.errors);
        formErr.textContent = r.message || 'Something went wrong. Try again.';
      });
    });
  }

  // ---------- Share ----------
  function initShare(scope) {
    $$('[data-share]', scope).forEach(function (box) {
      var urlEl = $('[data-share-url]', box), msgEl = $('[data-share-msg]', box), hint = $('[data-share-hint]', box);
      var url = urlEl.value;
      var msg = function () { return msgEl.value.indexOf(url) === -1 ? msgEl.value + ' ' + url : msgEl.value; };
      var log = function (ch) { post('/api/share', { channel: ch }); };
      var legacyCopy = function (text) {
        var t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
        var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} document.body.removeChild(t); return ok;
      };
      var copy = function (text) {
        var viaApi = navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(text) : Promise.reject();
        return viaApi.then(function () { return true; }, function () { return legacyCopy(text); });
      };
      var setLinks = function () {
        var m = encodeURIComponent(msg());
        $$('[data-channel]', box).forEach(function (a) {
          var ch = a.getAttribute('data-channel');
          if (ch === 'whatsapp') a.href = 'https://wa.me/?text=' + m;
          if (ch === 'sms') a.href = 'sms:?&body=' + m;
          if (ch === 'email') a.href = 'mailto:?subject=' + encodeURIComponent('Come with me: free live event Nov 21') + '&body=' + m;
          if (ch === 'facebook') a.href = 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url);
        });
      };
      setLinks();
      msgEl.addEventListener('input', setLinks);
      $('[data-copy]', box).addEventListener('click', function () {
        copy(url).then(function (ok) {
          hint.textContent = ok ? 'Link copied. Paste it anywhere.' : 'Press and hold the link above to copy it.';
          if (!ok) { urlEl.focus(); urlEl.select(); }
          log('copy');
        });
      });
      var nativeBtn = $('[data-share-native]', box);
      if (navigator.share) {
        nativeBtn.hidden = false;
        nativeBtn.addEventListener('click', function () {
          navigator.share({ title: 'Free live session — Klee & Ruben', text: msgEl.value.replace(url, '').trim(), url: url }).then(function () { log('native'); }).catch(function () {});
        });
      }
      $$('[data-channel]', box).forEach(function (a) {
        a.addEventListener('click', function () {
          var ch = a.getAttribute('data-channel');
          log(ch);
          if (ch === 'instagram' || ch === 'tiktok') {
            copy(msg()).then(function (ok) {
              hint.textContent = (ok ? '' : 'Copy the message above, then: ') + (ch === 'instagram'
                ? 'Message and link copied. Open Instagram and paste it in a DM, or add your link to a Story with the Link sticker or to your bio. Websites can’t post to Instagram for you.'
                : 'Message and link copied. Open TikTok and paste it in your bio, a caption or a DM. Websites can’t post to TikTok for you.');
            });
          }
        });
      });
    });
  }
  initShare(document);

  // ---------- Raffle picker ----------
  var rf = $('[data-raffle-form]');
  if (rf) {
    var tallyEl = $('[data-tally]', rf), totalEl = $('[data-total]', rf), custom = $('[data-custom]', rf), qtyInput = $('#custom-qty'), qtyErr = $('[data-qty-error]', rf);
    var max = boot.maxEntries || 500, shown = 10;
    var qty = function () {
      var sel = $('input[name=bundle]:checked', rf);
      return sel && sel.value === 'custom' ? Number(qtyInput.value) : Number(sel ? sel.value : 0);
    };
    var validQty = function (n) {
      if (!Number.isInteger(n) || n < 5) return 'The minimum purchase is 5 entries ($5).';
      if (n % 5) return 'Entries come in bundles of 5. Choose 5, 10, 15, and so on.';
      if (n > max) return 'The most you can buy at once is ' + max + ' entries.';
      return '';
    };
    var animateTo = function (n) {
      if (reduced) { tallyEl.textContent = n; shown = n; return; }
      var from = shown, t0 = performance.now();
      var step = function (t) { var k = Math.min(1, (t - t0) / 420); var v = Math.round(from + (n - from) * (1 - Math.pow(1 - k, 3))); tallyEl.textContent = v; if (k < 1) requestAnimationFrame(step); else shown = n; };
      requestAnimationFrame(step);
    };
    var update = function () {
      var sel = $('input[name=bundle]:checked', rf);
      custom.hidden = !(sel && sel.value === 'custom');
      var n = qty(), err = validQty(n);
      qtyErr.textContent = custom.hidden ? '' : err;
      if (!err) { animateTo(n); totalEl.textContent = '$' + n.toFixed(2); }
      var b = $('[data-checkout]', rf); if (b) b.disabled = Boolean(err);
    };
    $$('input[name=bundle]', rf).forEach(function (r) { r.addEventListener('change', update); });
    qtyInput.addEventListener('input', update);
    $$('[data-step]', rf).forEach(function (b) {
      b.addEventListener('click', function () {
        var n = Math.max(5, Math.min(max, (Math.round((Number(qtyInput.value) || 0) / 5) * 5) + Number(b.getAttribute('data-step'))));
        qtyInput.value = n; update();
      });
    });
    update();
    rf.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var errEl = $('[data-raffle-error]', rf), btn = $('[data-checkout]', rf);
      if (!btn) return;
      errEl.textContent = '';
      var n = qty(), err = validQty(n);
      if (err) { errEl.textContent = err; return; }
      var age = rf.elements.age;
      if (age && !age.checked) { errEl.textContent = 'Confirm your age to continue.'; age.focus(); return; }
      busy(btn, true);
      post('/api/raffle/checkout', { quantity: n, age: true }).then(function (r) {
        if (r.ok && r.url) { window.location.assign(r.url); return; }
        busy(btn, false);
        errEl.textContent = r.message || 'Checkout couldn’t start. Try again.';
      });
    });
    if ('IntersectionObserver' in window) {
      var seen = new IntersectionObserver(function (e) { if (e[0].isIntersecting) { seen.disconnect(); track('raffle_viewed'); } }, { threshold: .4 });
      seen.observe(rf);
    }
  }

  // ---------- Find my registration ----------
  var dlg = $('[data-lookup]');
  $$('[data-open-lookup]').forEach(function (b) {
    b.addEventListener('click', function () { if (dlg && dlg.showModal) dlg.showModal(); else if (dlg) dlg.setAttribute('open', ''); });
  });
  var lf = $('[data-lookup-form]');
  if (lf) {
    lf.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var err = $('[data-lookup-error]', lf), btn = $('button[type=submit]', lf);
      err.textContent = '';
      busy(btn, true);
      post('/api/lookup', { email: lf.elements.email.value, confirmation_no: lf.elements.confirmation_no.value }).then(function (r) {
        busy(btn, false);
        if (r.ok) { window.location.href = '/me'; return; }
        err.textContent = r.message || 'We couldn’t find that registration.';
      });
    });
  }

  // ---------- Personal page: update details ----------
  var mf = $('[data-me-form]');
  if (mf) {
    mf.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var data = formToObject(mf), btn = $('button[type=submit]', mf), err = $('[data-form-error]', mf), ok = $('[data-form-ok]', mf);
      err.textContent = ''; ok.textContent = '';
      busy(btn, true);
      post('/api/me', data).then(function (r) {
        busy(btn, false);
        if (r.ok) { showErrors(mf, {}); ok.textContent = 'Saved.'; return; }
        if (r.errors) showErrors(mf, r.errors);
        err.textContent = r.message || 'Couldn’t save. Try again.';
      });
    });
  }

  // ---------- Receipt: wait for payment confirmation ----------
  if ($('[data-autorefresh]')) {
    var tries = 0;
    try { tries = Number(sessionStorage.getItem('kr-refresh') || 0); } catch (e) {}
    if (tries < 10) {
      setTimeout(function () { try { sessionStorage.setItem('kr-refresh', String(tries + 1)); } catch (e) {} location.reload(); }, 3000);
    }
  } else {
    try { sessionStorage.removeItem('kr-refresh'); } catch (e) {}
  }
})();
