import type { JSX } from "react";
import { CreateRestaurantForm } from "./create-restaurant-form";

/**
 * Create Your Restaurant — `UX_MAP.md`, "Getting In", and the last gap in the path from
 * registering to a working Dashboard. It was a stub whose only job was to give the login fork a
 * real destination; the fork has been proved for several sprints and the screen is now the thing
 * a new owner actually fills in.
 */
export default function CreateRestaurantPage(): JSX.Element {
  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <CreateRestaurantForm />
    </main>
  );
}
