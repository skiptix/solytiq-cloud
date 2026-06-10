# Threat Model - Solytiq Cloud

## 1. Assets
- **User Authentication Data:** Passwords (hashed), TOTP secrets, JWT tokens.
- **Personal & Workspace Data:** Tasks, Lists, Folders, Workspaces (structure and content).
- **Uploaded Files:** User-uploaded documents, images, and GPS files.
- **Public Share Links:** Tokens and passwords for accessing shared files.
- **GPS/Location Data:** Potentially sensitive movement/location history.
- **AI Context:** Chat history, prompts, and processed file content.
- **Infrastructure Secrets:** `JWT_SECRET`, `POSTGRES_PASSWORD`, `OPENROUTER_API_KEY`.
- **System Integrity:** Admin endpoints (`/api/admin/*`), database state.

## 2. Trust Boundaries
- **TB1: Browser <-> Nginx:** Public internet boundary. TLS termination (if configured), security headers.
- **TB2: Nginx <-> Backend:** Internal Docker network. Assumes Nginx is trusted.
- **TB3: Backend <-> PostgreSQL:** Internal Docker network. Assumes DB is trusted, but uses credentials.
- **TB4: Backend <-> File Storage:** Local filesystem access within the backend container.
- **TB5: Backend <-> OpenRouter API:** Outbound request to a third-party service.
- **TB6: User <-> User (Workspaces):** Logical boundary between different tenants/users.

## 3. Attacker Profiles
- **External Attacker:** No credentials, trying to gain access, DoS the system, or find public shares.
- **Malicious User:** Registered user trying to access other users' data (IDOR) or escalate to Admin.
- **Workspace Member:** Trying to exceed permissions within a workspace (e.g., modifying owner's tasks).
- **Compromised Account:** Attacker with a stolen JWT or session.
- **Malicious Admin:** User with admin rights performing destructive actions without oversight.

## 4. STRIDE Analysis

| Threat | Description | Mitigation Strategy |
| :--- | :--- | :--- |
| **S**poofing | JWT forgery or session hijacking. 2FA bypass. | Secure JWT signing, mandatory 2FA (if enabled), Secure/HttpOnly cookies (not currently used, JWT in LocalStorage). |
| **T**ampering | Modifying tasks, lists, or files belonging to others via IDOR. | Strict server-side ownership checks on every request. |
| **R**epudiation | Performing destructive actions (e.g., Nuke) without audit trails. | Implement audit logging for sensitive admin actions. |
| **I**nformation Disclosure | Leaking data via SSE, error messages, or predictable share tokens. | SSE scoping, generic error messages, high-entropy tokens. |
| **D**enial of Service | Resource exhaustion via large uploads, SSE connections, or complex AI prompts. | Rate limiting (implemented), file size limits, timeout configurations. |
| **E**levation of Privilege | Exploiting first-user-admin logic or workspace role bugs. | Robust initialization logic, strict RBAC middleware. |
