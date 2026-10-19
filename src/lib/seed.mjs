// First-run content. Everything here is editable in the admin dashboard.
import { one, run, batch, now } from '../db.mjs';

const FAQS = [
  ['Is admission free?', 'Yes. Admission is free — you just need to RSVP so we can plan food and space.'],
  ['Do I need to RSVP?', 'Yes. RSVP on this page to save your spot. You’ll get a confirmation number and your own event page.'],
  ['Where in Maryland is the event?', 'The exact venue will be announced soon. Everyone who RSVPs will be notified as soon as the address is confirmed, and it will be posted on this page.'],
  ['What time does the event begin?', 'Saturday, November 21, 2026, from 6:00 PM to 9:00 PM Eastern Time. Arriving 15 minutes early is a good idea.'],
  ['Can children and teenagers attend?', 'Yes. Kids and teens ages 8 and up are welcome with a parent or guardian.'],
  ['What should I bring?', 'Your confirmation number (on your phone is fine), a photo ID if you bought raffle entries, and a notebook or phone for notes. If you want to review your own credit report, you can request free reports at [AnnualCreditReport.com](https://www.annualcreditreport.com) before the event.'],
  ['Will food be available?', 'Yes, free food will be served while it lasts.'],
  ['What topics will be taught?', 'Trading fundamentals, day-trading concepts, crypto basics, live strategy walkthroughs, risk management, how credit reports and scores work, the credit-report dispute process, and responsible credit-building habits.'],
  ['How do the raffles work?', 'Raffle entries are sold online in bundles of 5 for $5, with a $5 minimum. Entries are added only after your payment is confirmed. Full details are in the raffle rules.'],
  ['How do I earn referral bonus entries?', 'After you RSVP you get a personal invite link. When someone RSVPs through your link and completes a qualifying raffle purchase, you earn 2 bonus entries, subject to the raffle rules.'],
  ['Can I attend without buying raffle entries?', 'Yes. The event is free, and buying raffle entries is completely optional.'],
  ['How will winners be selected and contacted?', 'The drawing method and time are published in the raffle rules before sales open. Winners are contacted using the email or phone number on their registration.'],
  ['What are the raffle eligibility requirements?', 'You must be registered and at least 18 years old to buy entries. Any other requirements are listed in the raffle rules.'],
  ['Is trading education financial advice?', 'No. All trading, crypto and credit content is general education — not financial, investment, legal or credit advice. Trading involves risk, including the loss of money, and no specific result is promised.'],
  ['How do I contact the organizers?', 'Use the contact details at the bottom of this page.'],
];

export async function seed() {
  if (!(await one('SELECT 1 AS x FROM faqs LIMIT 1'))) {
    await batch(FAQS.map(([q, a], i) => ['INSERT INTO faqs (question, answer, published, sort_order, updated_at) VALUES (?, ?, 1, ?, ?)', q, a, i, now()]));
  }
  if (!(await one('SELECT 1 AS x FROM prizes LIMIT 1'))) {
    const t = now();
    await run(`INSERT INTO prizes (name, description, eligibility, restrictions, confirmation, published, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 1, 0, ?, ?)`,
      'Round-trip flight anywhere in the U.S.',
      'One round-trip flight to a destination in the United States.',
      'Details coming soon.',
      'Airline, travel dates, blackout dates and any value limit will be posted once confirmed.', t, t);
  }
}
