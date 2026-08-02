# SEQUENCE — Refund / Chargeback

Mermaid source. Renders as a diagram when pasted into a chat with Claude or into a Mermaid-aware viewer (e.g. mermaid.live). Kept as `.md` here only because Project Knowledge doesn't accept `.mmd`/`.mermaid` as an upload extension — the content is identical to `SEQUENCE_REFUND_CHARGEBACK.mermaid`.

```mermaid
sequenceDiagram
    participant Staff as Restaurant Staff
    participant S as Stripe Dashboard
    participant API as Backend API
    participant L as Ledger Module
    participant OB as Outbox Table
    participant W as Outbox Worker

    Staff->>S: Initiates refund manually (no self-service UI in MVP)
    S--)API: Webhook charge.refunded
    API->>API: Dedup by event id, verify signature

    rect rgb(30,30,30)
        Note over API,L: One transaction. Original JournalEntry is never touched.
        API->>L: Create Refund row
        L->>L: Create new JournalEntry (refund_issued)
        L->>L: Compensating LedgerLines: reverse Restaurant Revenue<br/>and Tip Payable, post to Refund Contra
        L->>OB: Insert OutboxEvent
    end

    API->>API: Write AuditLog: refund_issued
    W->>OB: Poll and dispatch
    Note over W: Wallet, Restaurant balance, Analytics catch up

    Note over Staff,S: Chargeback follows the same pattern, different trigger

    S--)API: Webhook charge.dispute.created
    API->>L: Create Chargeback (status: under_review)<br/>plus a provisional compensating JournalEntry

    Note over API,L: MVP simplification: treats a new dispute as provisionally<br/>lost. No separate held-funds account yet (see ADR-016).

    S--)API: Webhook charge.dispute.closed

    alt Dispute won
        API->>L: New JournalEntry reversing the provisional entry
    else Dispute lost
        API->>API: Chargeback status: lost. Already reflected, no further action.
    end
```
