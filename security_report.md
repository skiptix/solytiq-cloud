# Security Audit Report - Solytiq Cloud

## Executive Summary
This report summarizes the security audit of the Solytiq Cloud repository. Several vulnerabilities were identified and patched, ranging from High-severity authorization issues (IDOR) to Medium-severity infrastructure hardening.

---

## Findings & Resolutions

### [High] IDOR: Unauthorized Modification of Public Lists
**Affected File:** `backend/src/routes/lists.ts`
**Status:** Fixed
**Description:**
Previously, any authenticated user could modify a list if it was public.
**Resolution:**
Restricted all `PUT` and `DELETE` operations on lists to the owner or an admin only. Public status now only grants read access to other users.

---

### [High] IDOR: Unauthorized Deletion/Privacy-Toggle of Public Folders
**Affected File:** `backend/src/routes/folders.ts`
**Status:** Fixed
**Description:**
Public folders could be deleted or made private by any user.
**Resolution:**
Restricted folder deletion and the `is_public` toggle to the owner or an admin. Cosmetic updates (name, emoji, color) remain allowed for all users on public folders to support collaboration.

---

### [Medium] Registration Race Condition during Setup
**Affected File:** `backend/src/routes/auth.ts`
**Status:** Fixed
**Description:**
Parallel requests could create multiple admin users during the initial setup phase.
**Resolution:**
Implemented a PostgreSQL advisory lock (`pg_advisory_xact_lock`) within a transaction to ensure atomic setup registration.

---

### [Medium] Insecure Profile Image Payloads
**Affected File:** `backend/src/routes/auth.ts`
**Status:** Fixed
**Description:**
The API accepted arbitrary strings and oversized payloads for profile images.
**Resolution:**
Implemented strict regex validation for Base64 PNG, JPEG, and WebP images. Enforced a 512KB binary size limit.

---

### [Medium] Insecure Defaults for JWT Secret
**Affected File:** `backend/src/auth.ts`
**Status:** Fixed
**Description:**
The application could start in production with a default secret.
**Resolution:**
Modified the boot sequence to throw a fatal error if `NODE_ENV=production` and `JWT_SECRET` is missing or set to the default fallback.

---

### [Medium] Missing Rate Limiting
**Affected File:** `backend/src/index.ts`
**Status:** Fixed
**Description:**
Vulnerability to brute-force attacks on auth and admin endpoints.
**Resolution:**
Implemented `express-rate-limit`:
- General API: 300 reqs / 15 mins
- Login: 10 attempts / 15 mins
- Register/Nuke: 5 attempts / hour

---

### [Low] Missing Security Headers
**Affected Files:** `nginx/nginx.conf`, `backend/src/index.ts`
**Status:** Fixed
**Description:**
Missing standard protection against Clickjacking, MIME-sniffing, etc.
**Resolution:**
- Integrated `helmet` in Express (with CSP disabled to maintain asset compatibility).
- Added `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy` to Nginx.

---

### [Low] Information Disclosure in Members Endpoint
**Affected File:** `backend/src/routes/auth.ts`
**Status:** Fixed
**Description:**
User emails were exposed to all logged-in users.
**Resolution:**
Modified the `/members` endpoint to only return email addresses if the requesting user has the admin role.
