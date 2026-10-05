import { isIP } from 'node:net';

/**
 * The network a sign-in attempt is counted against for the per-viewer lockout.
 *
 * IPv4 addresses count individually. An IPv6 client normally controls a whole /64 (SLAAC, privacy
 * addresses), so counting single IPv6 addresses would let one client rotate past the lockout at will:
 * IPv6 attempts are counted per /64 prefix (`2001:db8:1:2::/64`). IPv4-mapped IPv6 (`::ffff:192.0.2.1`)
 * is treated as the IPv4 address. Anything that is not an IP address is returned trimmed and lower-cased
 * (it is only ever hashed).
 */
export function viewerNetwork(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined) return null;
  const value = ip.trim().toLowerCase();
  if (value === '') return null;
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) return mapped[1];
  if (isIP(value) !== 6) return value;
  const groups = expandIpv6(value);
  if (groups === null) return value;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of an IPv6 address (hex, no leading-zero normalisation), or null. */
function expandIpv6(address: string): string[] | null {
  let text = address.split('%')[0] ?? address; // zone index
  // Embedded IPv4 tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) → two hex groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' && halves[1] !== undefined ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
}
