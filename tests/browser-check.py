"""Scenario 15: real-browser check on phone, tablet, laptop and large desktop widths.
Requires: pip install playwright && playwright install chromium. Run against a running server:
  python3 tests/browser-check.py http://localhost:3000 [screenshot-dir]
"""
import sys, os, random
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:3000'
OUT = sys.argv[2] if len(sys.argv) > 2 else '.'
problems = []

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, w, h in [('phone', 390, 844), ('tablet', 820, 1180), ('laptop', 1366, 800), ('desktop', 1920, 1080)]:
        pg = b.new_page(viewport={'width': w, 'height': h})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/', wait_until='networkidle')
        overflow = pg.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')
        if overflow > 0: problems.append(f'{name}: horizontal overflow {overflow}px')
        if errs: problems.append(f'{name}: JS errors {errs}')
        small = pg.evaluate("""[...document.querySelectorAll('.btn, .sbtn, .bundle__tkt, .faq__item summary, .nav__toggle')]
          .filter(e => e.offsetParent && e.getBoundingClientRect().height < 40).length""")
        if small: problems.append(f'{name}: {small} tap targets under 40px tall')
        print(f'{name:8} {w}px  overflow={overflow}  js_errors={len(errs)}  small_targets={small}')
        pg.close()

    # Full RSVP through the real form on a phone
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    pg = ctx.new_page()
    pg.goto(BASE + '/#rsvp', wait_until='networkidle')
    pg.click('[data-submit]')  # empty submit shows errors
    if not pg.is_visible('[data-error-for="email"]:not(:empty)'): problems.append('empty form did not show field errors')
    n = random.randint(1000, 9999)
    pg.fill('#f-first_name', 'Maya'); pg.fill('#f-last_name', 'Brooks')
    pg.fill('#f-email', f'maya{n}@example.com'); pg.fill('#f-phone', f'(301) 555-{n}')
    pg.click('label.pill:has-text("Cryptocurrency")'); pg.click('label.pill:has-text("Credit education")')
    pg.check('input[name=understands_in_person]'); pg.check('input[name=privacy_agreed]')
    pg.wait_for_timeout(3200)  # bot check: form must be open 3s
    pg.click('[data-submit]')
    pg.wait_for_selector('[data-confirm]:not([hidden])', timeout=8000)
    conf = pg.inner_text('.confirm__ticket')
    print('confirmation screen:', ' | '.join(conf.split('\n')[:2]))
    pg.screenshot(path=os.path.join(OUT, 'phone-confirmation.png'), full_page=False)
    pg.click('[data-copy]'); pg.wait_for_timeout(300)
    print('copy hint:', pg.inner_text('[data-share-hint]'))
    pg.click('button[data-channel=instagram]'); pg.wait_for_timeout(300)
    if 'Instagram' not in pg.inner_text('[data-share-hint]'): problems.append('instagram hint missing')
    pg.goto(BASE + '/me', wait_until='networkidle')
    if 'Hey Maya' not in pg.content(): problems.append('/me did not load for the new attendee')
    pg.screenshot(path=os.path.join(OUT, 'phone-my-page.png'), full_page=True)
    b.close()

print('\nPROBLEMS:\n' + '\n'.join(problems) if problems else '\nScenario 15 passed: no overflow, no JS errors, real RSVP works on a phone.')
sys.exit(1 if problems else 0)
