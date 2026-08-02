export interface RouteEntry {
  path: string;
  feature: string;
}

/** The single source of truth for top-level navigation. */
export const routeTable: RouteEntry[] = [
  { path: '/checkout', feature: 'checkout' },
  { path: '/catalog', feature: 'catalog' },
  { path: '/orders', feature: 'orders' },
];
