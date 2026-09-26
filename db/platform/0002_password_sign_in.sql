-- Email + password sign-in. Passwords are stored only as scrypt hashes (server/src/auth/passwords.ts).
--
-- `email_verified` records whether whoever controls the account has proven they own its email
-- address — with an emailed code, or through Apple's verified email. Creating an account with a
-- password proves nothing about the address, so such an account stays unverified until someone
-- proves ownership; that proof reclaims it (the unproven password is cleared and its sessions
-- end), so registering someone else's address first can never lock them out or let the
-- registrant into their data later.

alter table auth.users add column encrypted_password text;
alter table auth.users add column email_verified boolean not null default false;

-- Every account created so far signed in with an emailed code or a verified Apple email.
update auth.users set email_verified = true where email is not null;

alter table auth.sessions drop constraint sessions_method_check;
alter table auth.sessions add constraint sessions_method_check check (method in ('otp', 'apple', 'password'));
