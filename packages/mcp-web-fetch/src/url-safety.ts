import dns from 'node:dns';

export class UrlSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlSafetyError';
  }
}

/**
 * Returns true if the given dotted-quad IPv4 address falls within a
 * private, loopback, link-local, unspecified, or CGNAT range.
 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
    octets.push(n);
  }
  const [a, b] = octets;

  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 100.64.0.0/10 (CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local, incl. 169.254.169.254 metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  return false;
}

/**
 * Returns true if the given IPv6 address is loopback, unique-local,
 * link-local, unspecified, or an IPv4-mapped address whose embedded
 * IPv4 address is private.
 */
export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Unspecified
  if (normalized === '::') return true;
  // Loopback
  if (normalized === '::1') return true;

  // IPv4-mapped: ::ffff:x.x.x.x
  const v4MappedMatch = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch) {
    return isPrivateIpv4(v4MappedMatch[1]);
  }

  // fc00::/7 (Unique Local Address) -> first 7 bits are 1111 110x
  // i.e. first hex group's value, when masked, falls in 0xfc00-0xfdff
  const firstGroup = normalized.split(':')[0];
  if (/^[0-9a-f]{1,4}$/.test(firstGroup)) {
    const value = parseInt(firstGroup, 16);
    // fc00::/7 => top 7 bits of first 16-bit group are 1111110
    if ((value & 0xfe00) === 0xfc00) return true;
    // fe80::/10 (link-local) => top 10 bits are 1111111010
    if ((value & 0xffc0) === 0xfe80) return true;
  }

  return false;
}

/**
 * Returns true if the host should be blocked outright: localhost,
 * *.localhost, *.local, or a literal IP address that is private.
 */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().trim();

  if (h === 'localhost') return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;

  // Strip brackets from literal IPv6 hosts, e.g. "[::1]"
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // IPv4 literal
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) {
    return isPrivateIpv4(bare);
  }

  // IPv6 literal (contains a colon)
  if (bare.includes(':')) {
    return isPrivateIpv6(bare);
  }

  return false;
}

/**
 * Parses and validates a URL for safe outbound fetching.
 *
 * Throws UrlSafetyError unless:
 *  - protocol is http: or https:
 *  - there are no embedded credentials (username/password)
 *  - a host is present
 *  - the host is not in opts.denyHosts
 *  - if opts.allowHosts is given, the host must be in it
 *  - the host is not blocked per isBlockedHostname
 */
export function parseAndValidateUrl(
  rawUrl: string,
  opts?: { allowHosts?: string[]; denyHosts?: string[] },
): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlSafetyError(`Invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlSafetyError(`Unsupported protocol: ${url.protocol}`);
  }

  if (url.username || url.password) {
    throw new UrlSafetyError('URLs with embedded credentials are not allowed');
  }

  const host = url.hostname;
  if (!host) {
    throw new UrlSafetyError('URL has no host');
  }

  const lowerHost = host.toLowerCase();

  if (opts?.denyHosts?.some((h) => h.toLowerCase() === lowerHost)) {
    throw new UrlSafetyError(`Host is denied: ${host}`);
  }

  if (opts?.allowHosts && opts.allowHosts.length > 0) {
    if (!opts.allowHosts.some((h) => h.toLowerCase() === lowerHost)) {
      throw new UrlSafetyError(`Host is not in allow list: ${host}`);
    }
  }

  if (isBlockedHostname(host)) {
    throw new UrlSafetyError(`Host is blocked: ${host}`);
  }

  return url;
}

/**
 * Resolves the given hostname via DNS and throws UrlSafetyError if any
 * resolved address is private. If the host is already a literal IP
 * address, it is validated directly without performing DNS lookups.
 */
export async function assertResolvedHostSafe(host: string): Promise<void> {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  // Literal IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) {
    if (isPrivateIpv4(bare)) {
      throw new UrlSafetyError(`Host resolves to a private address: ${bare}`);
    }
    return;
  }

  // Literal IPv6
  if (bare.includes(':')) {
    if (isPrivateIpv6(bare)) {
      throw new UrlSafetyError(`Host resolves to a private address: ${bare}`);
    }
    return;
  }

  const results = await dns.promises.lookup(host, { all: true });
  for (const { address, family } of results) {
    const isPrivate = family === 6 ? isPrivateIpv6(address) : isPrivateIpv4(address);
    if (isPrivate) {
      throw new UrlSafetyError(`Host resolves to a private address: ${host} -> ${address}`);
    }
  }
}
