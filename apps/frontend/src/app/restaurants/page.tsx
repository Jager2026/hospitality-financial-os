import type { JSX } from "react";
import { RestaurantsList } from "./restaurants-list";

/** Restaurants list — where an org-wide Membership lands after login (`UX_MAP.md`), and the only
 * route to a Dashboard for anyone who does not already know its id. */
export default function RestaurantsPage(): JSX.Element {
  return <RestaurantsList />;
}
