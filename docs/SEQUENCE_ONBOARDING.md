# SEQUENCE — Restaurant Onboarding

Mermaid source. Renders as a diagram when pasted into a chat with Claude or into a Mermaid-aware viewer (e.g. mermaid.live). Kept as `.md` here only because Project Knowledge doesn't accept `.mmd`/`.mermaid` as an upload extension — the content is identical to `SEQUENCE_ONBOARDING.mermaid`.

```mermaid
sequenceDiagram
    participant O as Owner
    participant API as Backend API
    participant DB as Database
    participant S as Stripe

    O->>API: POST /restaurants (country: LT, currency: EUR)
    API->>DB: Create Organization if none exists
    API->>DB: Create org-wide Membership for Owner
    API->>DB: Create Restaurant (onboarding_status: NOT_STARTED)
    API->>S: Create Connect Account (Standard-equivalent, dashboard: "full")
    S-->>API: stripe_account_id
    API->>DB: Save stripe_account_id
    API->>S: Create Account Link
    S-->>API: Onboarding URL
    API-->>O: Redirect to Stripe-hosted onboarding

    Note over O,S: KYC and bank details entered on Stripe's own pages,<br/>never touching our servers

    O->>S: Completes onboarding form
    S-->>O: Redirect back to Restaurant Portal

    loop As requirements are satisfied
        S--)API: Webhook account.updated
        API->>DB: Update onboarding_status, card_payments_status,<br/>payouts_status, requirements_due
    end

    alt card_payments_status == active and payouts_status == active
        Note over O: Dashboard banner disappears.<br/>Restaurant can now accept its first Payment.
    else Still incomplete
        Note over O: Dashboard banner persists,<br/>naming the specific outstanding requirement
    end

    Note over O,S: A second Restaurant repeats this entire sequence<br/>independently, with its own Stripe account (ADR-009)
```
