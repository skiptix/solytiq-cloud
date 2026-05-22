# Security Audit Report - Solytiq Cloud

## Executive Summary
This report summarizes the security audit of the Solytiq Cloud repository. Several vulnerabilities were identified, ranging from High-severity authorization issues (IDOR) to Medium-severity infrastructure hardening needs. The most critical issues involve unauthorized modification of public lists and folders by any authenticated user.

---

## Findings

### [High] IDOR: Unauthorized Modification of Public Lists
**Affected File:** `backend/src/routes/lists.ts`

**Description:**
The `PUT /api/lists/:listId` endpoint allows any authenticated user to modify a list if it is marked as public (`is_public = true`). An attacker can change the list name, emoji, or even its `is_public` status (making it private) and `folder_id` (moving it to their own folder).

**Risks:**
Users can hijack public lists created by others, potentially causing data loss or unauthorized access.

**Recommended Fix:**
Restrict modifications to the list owner only, or strictly limit what can be modified by non-owners on public lists.

---

### [High] IDOR: Unauthorized Deletion and Modification of Public Folders
**Affected File:** `backend/src/routes/folders.ts`

**Description:**
The `PUT /api/folders/:id` and `DELETE /api/folders/:id` endpoints allow any authenticated user to modify or delete a folder if it is public. Deleting a public folder unlinks all lists associated with it.

**Risks:**
Destructive actions on shared resources by any user.

**Recommended Fix:**
Restrict `DELETE` and `PUT` (for sensitive fields like `is_public`) to the folder owner.

---

### [Medium] Registration Race Condition during Setup
**Affected File:** `backend/src/routes/auth.ts`

**Description:**
The `POST /api/auth/register` endpoint checks if any user exists using `SELECT COUNT(*)`. In a race condition, two parallel requests could both see 0 users and proceed to create two admin users.

**Risks:**
Multiple admin accounts could be created if the setup is accessed simultaneously by multiple people.

**Recommended Fix:**
Use a database transaction or a more robust locking mechanism. Alternatively, rely on the `UNIQUE` constraint on the `is_admin` column (if added) or just accept that the first one wins via the existing unique constraints on `username`/`email`.

---

### [Medium] Missing Profile Image Validation
**Affected File:** `backend/src/routes/auth.ts`

**Description:**
`PUT /api/auth/profile-image` accepts any string as `imageData` without validating if it is a valid image or checking its size beyond the global 4MB JSON limit.

**Risks:**
Storage of malicious payloads or extremely large strings, potentially leading to DoS or XSS if rendered unsafely.

**Recommended Fix:**
Validate the base64 string prefix (e.g., `data:image/...`) and check the actual size of the decoded data.

---

### [Medium] Insecure Defaults for JWT Secret
**Affected File:** `backend/src/auth.ts`

**Description:**
The `JWT_SECRET` defaults to `changeme-secret` if not provided in the environment.

**Risks:**
If a user forgets to set the secret in production, the application is vulnerable to token forgery.

**Recommended Fix:**
Force a crash or a loud warning if `NODE_ENV=production` and the secret is the default.

---

### [Medium] Missing Rate Limiting
**Affected File:** `backend/src/index.ts`

**Description:**
There is no rate limiting on sensitive endpoints like `/api/auth/login`, `/api/auth/register`, or `/api/admin/nuke`.

**Risks:**
Brute-force attacks on login and potential DoS on registration/setup.

**Recommended Fix:**
Implement `express-rate-limit` on the API, with stricter limits on auth endpoints.

---

### [Low] Missing Security Headers
**Affected File:** `nginx/nginx.conf`, `backend/src/index.ts`

**Description:**
The Nginx and Express configurations are missing standard security headers (e.g., `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`).

**Risks:**
Increased vulnerability to Clickjacking, XSS, and MIME-sniffing.

**Recommended Fix:**
Use `helmet` middleware in Express and add security headers to the Nginx configuration.

---

### [Low] Excessive Information Disclosure in Members Endpoint
**Affected File:** `backend/src/routes/auth.ts`

**Description:**
`GET /api/auth/members` returns the email addresses of all users to any logged-in user.

**Risks:**
While intended for a "multi-user" app, this might be undesirable for privacy-conscious self-hosters.

**Recommended Fix:**
Consider making email disclosure optional or admin-only.

---

## Patch Plan

1. **Authorization:** Fix IDOR in `lists.ts` and `folders.ts`.
2. **Setup:** Add a guard to `auth.ts` for setup race conditions.
3. **Validation:** Implement profile image validation.
4. **Hardening:** Add `helmet`, `express-rate-limit`, and Nginx security headers.
5. **Environment:** Improve JWT secret handling for production.
