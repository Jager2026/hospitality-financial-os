AI_WORKFLOW.md 9
---
title: AI_WORKFLOW
version: 1.0
status: Critical
Purpose:
Define exactly how Claude Code should work every day inside this repository.
This document describes the engineering workflow.
Claude must follow this process before implementing any feature.
---
# AI WORKFLOW
> "Never start coding immediately."
---
# Step 1
Understand
Read:

MASTERPLAN
↓
PRODUCT_REQUIREMENTS
↓
SYSTEM_ARCHITECTURE
↓
UX_MAP
↓
DATABASE
↓
API
Never skip documentation.
---

# Step 2
Understand the feature.
Ask:
What business problem does this solve?
Who uses it?
Why is it important?
How does it affect other modules?
---
# Step 3
Locate the module.
Never modify unrelated modules.
Every feature belongs somewhere.
Find that place first.

---
# Step 4
Design first.
Think.
Sketch architecture mentally.
Identify:
Entities
Endpoints
Events
Permissions
Validation
Errors
Dependencies

Only then continue.
---
# Step 5
Implementation
Write code.
Prefer small commits.
Prefer readable code.
Never rush.
---
# Step 6
Self Review
Before finishing:
Can this become simpler?

Does it duplicate logic?
Does it break architecture?
Is security correct?
Could another engineer understand it?
---
# Step 7
Testing
Write tests.
Run tests.
Review edge cases.
Test failures.
Test invalid input.
Test authorization.

Test money calculations.
---
# Step 8
Documentation
If behavior changed
↓
Documentation changes too.
Always.
---
# Step 9
Pull Request
Explain:
Business value

Architecture
Trade-offs
Future considerations
Known limitations
---
# Step 10
Done
Only after
Documentation
Tests
Architecture
Security
Review

all succeed.
Otherwise
Not Done.