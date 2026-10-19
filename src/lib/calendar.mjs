import { config } from '../config.mjs';
import { getSettings, eventTimes } from './settings.mjs';
import { icsStamp } from './time.mjs';

export function venueText(s = getSettings()) {
  const v = [s.event.venue_name, s.event.venue_address].filter(Boolean).join(', ');
  return v || 'Maryland — exact address to be announced';
}

export function eventDescription() {
  return `Free live in-person session hosted by ${getSettings().event.hosts}: trading education, crypto education, credit education, networking, Q&A, free food, games, prizes and live performances. Details: ${config.baseUrl}`;
}

export function googleCalendarUrl() {
  const s = getSettings();
  const { start, end } = eventTimes(s);
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: `${s.event.name} — ${s.event.hosts}`,
    dates: `${icsStamp(start)}/${icsStamp(end)}`,
    details: eventDescription(),
    location: venueText(s),
    ctz: s.event.timezone,
  });
  return `https://calendar.google.com/calendar/render?${p}`;
}

const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

export function icsFile() {
  const s = getSettings();
  const { start, end } = eventTimes(s);
  const host = new URL(config.baseUrl).host;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Klee & Ruben Live//Event//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:main-event@${host}`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(`${s.event.name} — ${s.event.hosts}`)}`,
    `DESCRIPTION:${icsEscape(eventDescription())}`,
    `LOCATION:${icsEscape(venueText(s))}`,
    `URL:${config.baseUrl}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:Event starts in 2 hours', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}
