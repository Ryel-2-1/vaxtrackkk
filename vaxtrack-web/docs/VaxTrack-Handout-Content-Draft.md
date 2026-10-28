# VaxTrack capstone handout — content and page structure

Draft for content review. The project is currently under development. This file is a content plan, not the final two-page typeset document.

## Page 1 — The problem, proposed solution, and workflow

### Header

**VaxTrack: A Vaccine Inventory and Delivery Management System for 3MGS Pharma Inc.**

*Working title — pending confirmation against the approved manuscript*

Polytechnic University of the Philippines – Biñan Campus  
Bachelor of Science in Information Technology

**Researchers:** [COMPLETE, VERIFIED NAMES]  
**Adviser:** [COMPLETE, VERIFIED NAME]  
**Project status:** Under development

### Project background and problem

Vaccine distribution requires coordination between inventory staff, sales representatives, dispatchers, and delivery riders. Stock availability, batch expiry, order requirements, delivery progress, and supporting records need to remain connected throughout the process.

VaxTrack is being developed for 3MGS Pharma Inc. to bring these activities into a shared web and mobile system. It focuses on inventory visibility, delivery coordination, and traceable records in support of cold-chain logistics.

[INSERT ONE VERIFIED SENTENCE ON 3MGS’S CURRENT PROCESS AND DOCUMENTED PROBLEM FROM THE APPROVED MANUSCRIPT.]

### Project objectives

- Centralize vaccine batch, expiry, and stock-availability records.
- Connect ordering, stock allocation, dispatch preparation, and delivery updates.
- Provide role-based access and delivery evidence for operational traceability.

*Draft objectives — align with the approved manuscript before finalization.*

### Four connected user roles

| Role | Main responsibility | Platform |
|---|---|---|
| Admin | Oversees inventory, destinations, users, delivery records, and invoices. | Web |
| Sales Representative | Places orders and follows their progress. | Web |
| Dispatcher | Assigns riders, confirms cargo loading, and monitors deliveries. | Web |
| Rider | Receives assignments, follows navigation, reports progress, and submits delivery evidence. | Mobile |

### End-to-end workflow

**Place order → Reserve or queue stock → Assign rider → Confirm loading → Deliver → Record proof and completion**

Available stock is reserved for an order; orders awaiting stock remain in the allocation queue. Authorized updates connect the staff and rider views. Delays, cancellations, and returned stock follow exception-handling paths.

## Page 2 — System capabilities, architecture, and scope

### Key capabilities in the current implementation

- **Inventory and allocation:** Batch and expiry records, available and reserved quantities, backorders, and returned-stock disposition.
- **Ordering and scheduling:** Destination selection, requested delivery dates and arrival preferences, and order tracking.
- **Dispatch and tracking:** Rider assignment, loading confirmation, location displays, navigation, and route-deviation alerts.
- **Delivery records:** Status history, proof-of-delivery photos, invoice records, and operational dashboards.

**Implementation status:** These capabilities are represented in the current source code. Their inclusion does not establish deployment, successful physical testing, or readiness for operational use. Those statuses require separate evidence.

### Selected system views

**[SCREENSHOT A — CURRENT WEB INVENTORY VIEW]**  
*Caption: Batch, expiry, and stock-availability information in the web portal.*

**[SCREENSHOT B — CURRENT RIDER DELIVERY VIEW]**  
*Caption: Assigned delivery details and progress actions in the Rider app.*

### Compact architecture

**React/Vite web portal ↔ Firebase backend ↔ Flutter Rider app**

The web portal supports Admin, Sales Representative, and Dispatcher activities. The Flutter app supports rider delivery tasks. Firebase provides authentication, shared operational data, server-side operations, and photo storage. Role-based permissions control access and updates.

### Intended practical contribution

VaxTrack aims to provide a shared view of stock and delivery progress, clearer handoffs between roles, and traceable order and delivery records. These are intended benefits; improvements in efficiency, accuracy, or delivery performance have not been established by the evidence reviewed for this draft.

### Development status and limitations

- VaxTrack remains under development; deployment and physical field-test status are pending verification.
- Cold-chain logistics support does not include live temperature sensing or validated cold-chain compliance.
- Requested arrival preferences do not guarantee delivery times or establish fully time-window-aware routing.
- Location updates and synchronization depend on connectivity, permissions, and device conditions.
- The inventory forecasting module uses advisory baseline forecasting; predictive accuracy and advanced AI capability are not claimed.

## Production notes — exclude from the printed handout

### Proposed layout

- Two A4 portrait pages; approximately 15 mm margins and 10.5–11 pt body text, subject to render verification.
- Restrained VaxTrack green accents, dark text, white background, and clear headings.
- Page 1: title block, background/problem, objectives, role table, and one compact workflow diagram.
- Page 2: capabilities, two cropped screenshots side by side with captions, a compact architecture strip, intended contribution, and limitations.
- Convert the workflow line into six labeled nodes. Keep the architecture as a small strip so the workflow remains the main diagram.
- Use approved logos only when supplied. Until then, use text identification without substitute logos.
- Use approved screenshots with demonstration data or obscured personal/business data. Do not fabricate application screens.
- Do not include a contact block, QR code, staging URL, local-server URL, or unfinished deployment link.
- Prepare editable Word and matching PDF only after content review; render and inspect both pages before delivery.

### Missing information and evidence

1. Approved manuscript, or the approved title, problem statement, objectives, and scope excerpts. No approved manuscript was identified in the workspace search.
2. Complete, verified researcher and adviser names.
3. Approved VaxTrack, PUP, and 3MGS logo assets, if logos are to appear.
4. Selected current screenshots, permission to use their content, and confirmation that they match the defense demonstration.
5. Feature-by-feature deployment and physical-test evidence. Do not infer these statuses from implementation or old documentation.
6. Any required rubric or school handout template, if one is later supplied.

Methodology, evaluation scores, participant counts, performance gains, and client acceptance claims are omitted because approved supporting evidence was not supplied.

### Evidence basis

The institution, program, working title, audience, and current-development status come from the user. Product context comes from PRODUCT.md and VAXTRACK_SYSTEM_HANDBOOK.md, cross-checked against current App.jsx routes, AdminAllocation.jsx, SalesRepPlaceOrder.jsx, image_upload_service.dart, inventoryAnalytics.js, requestedArrival.js, and the shared live-tracking entry point. Older documents contain stale feature descriptions; current code supports implementation descriptions only, not deployment or field validation.
