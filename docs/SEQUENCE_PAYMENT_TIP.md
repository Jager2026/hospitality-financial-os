# SEQUENCE — Payment + Tip Flow

Mermaid source. Renders as a diagram when pasted into a chat with Claude or into a Mermaid-aware viewer (e.g. mermaid.live). Kept as `.md` here only because Project Knowledge doesn't accept `.mmd`/`.mermaid` as an upload extension — the content is identical to `SEQUENCE_PAYMENT_TIP.mermaid`.

```mermaid
sequenceDiagram
    participant C as Customer
    participant T as Terminal
    participant S as Stripe
    participant API as Backend API
    participant IK as IdempotencyKey
    participant L as Ledger Module
    participant OB as Outbox Table
    participant W as Outbox Worker
    participant Proj as Wallet / Restaurant / Analytics

    C->>T: Chooses tip, taps card
    T->>API: POST /payments (Idempotency-Key header)
    API->>IK: Check key + request fingerprint

    alt Key already completed
        IK-->>API: Return stored response
        API-->>T: Cached result, no new charge
    else New key
        API->>S: Confirm PaymentIntent
        S-->>T: Client-side confirmation (Stripe.js)
        T-->>C: Show Receipt now

        Note over T,C: Receipt is shown here — before Ledger,<br/>Wallet, or Dashboard are touched at all

        S--)API: Webhook payment_intent.succeeded (async, arrives later)
        API->>IK: Dedup by Stripe event id

        alt Already processed
            API-->>S: 200 OK, no reprocessing
        else First time
            API->>API: Verify Stripe signature
            rect rgb(30,30,30)
                Note over API,L: One database transaction
                API->>L: Create Transaction
                L->>L: Create JournalEntry (payment_captured)
                L->>L: Write LedgerLines: debit Processor Clearing,<br/>credit Restaurant Revenue, Platform Fee, Tip Payable
                L->>OB: Insert OutboxEvent
            end
            API->>API: Write AuditLog: payment_captured
            API-->>S: 200 OK
        end
    end

    loop Every 1-2 seconds
        W->>OB: Poll unpublished events
    end
    W->>Proj: Dispatch: update Wallet, Restaurant balance, Analytics
    W->>OB: Mark published_at = now

    Note over W,Proj: If the Worker crashes before this line,<br/>published_at stays null and the next poll retries.<br/>Handlers re-derive from LedgerLine, so reprocessing is safe.
```
