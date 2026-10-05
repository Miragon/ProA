package de.envite.proa.security;

import java.time.LocalDateTime;
import java.util.Objects;

import org.eclipse.microprofile.jwt.Claims;
import org.eclipse.microprofile.jwt.JsonWebToken;

import de.envite.proa.entities.authentication.Role;
import de.envite.proa.repository.project.ProjectInvitationDao;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.repository.user.UserDao;
import de.envite.proa.util.EmailNormalizer;
import io.quarkus.security.identity.SecurityIdentity;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.json.JsonValue;
import jakarta.persistence.PersistenceException;
import jakarta.ws.rs.NotAuthorizedException;

/**
 * Resolves the Keycloak-authenticated identity (web mode) to a local {@link UserTable} row.
 *
 * The row is keyed by the immutable OIDC subject claim; e-mail, first/last name and role are
 * profile data synced from the token on every resolve. The row is created on the first
 * authenticated request (first login); pending project invitations for the user's verified
 * e-mail are redeemed into memberships at the same point (ADR-0003). Application code consumes
 * {@link #getUserId()} instead of parsing token claims.
 *
 * In desktop mode there is no identity and this service must not be reached: the OIDC tenant
 * is disabled there, and every endpoint that calls this service sits behind a role annotation
 * ({@code @RolesAllowed} or web-mode-active {@code @RolesAllowedIfWebVersion}) that rejects
 * the then-anonymous requests with 401 before the resource method runs.
 */
@RequestScoped
public class CurrentUserService {

	private static final String GIVEN_NAME_CLAIM = "given_name";
	private static final String FAMILY_NAME_CLAIM = "family_name";

	@Inject
	JsonWebToken jwt;

	@Inject
	SecurityIdentity securityIdentity;

	@Inject
	UserDao userDao;

	@Inject
	ProjectInvitationDao projectInvitationDao;

	private UserTable user;

	public Long getUserId() {
		return getUser().getId();
	}

	/**
	 * No outer transaction on purpose: the DAO methods are transactional
	 * themselves, and a lost unique-constraint race during provisioning must
	 * only roll back the insert attempt, not the caller's work.
	 */
	public UserTable getUser() {
		if (user == null) {
			user = resolveUser();
		}
		return user;
	}

	private UserTable resolveUser() {
		String subject = resolveSubject();

		UserTable resolved = userDao.findBySubject(subject);
		if (resolved == null) {
			resolved = claimLegacyRowOrProvision(subject);
		}
		resolved = syncProfile(resolved);
		redeemInvitations(resolved);
		return resolved;
	}

	/**
	 * First login of this subject. One-time migration path: a row created before the subject
	 * binding (oidcSubject null) whose e-mail matches the token is claimed by backfilling the
	 * subject - guarded so it can happen exactly once and only with a verified e-mail
	 * (otherwise anyone self-registering an unverified copy of the address could inherit the
	 * legacy user's projects). A row whose e-mail matches but that is already bound to a
	 * different subject is never touched (e-mail recycling): a fresh row is created instead.
	 */
	private UserTable claimLegacyRowOrProvision(String subject) {
		String email = resolveEmail();
		if (email != null) {
			UserTable legacy = userDao.findLegacyByEmail(email);
			if (legacy != null) {
				if (!isEmailVerified()) {
					// Don't create a fresh row either: that would permanently orphan the
					// legacy row. The rightful owner can claim it after verifying.
					throw new NotAuthorizedException(
							"E-mail not verified - verify it to access your existing account", "Bearer");
				}
				if (userDao.claimSubject(legacy.getId(), subject)) {
					return userDao.findById(legacy.getId());
				}
				// Lost the claim race: either a parallel first request of this user already
				// claimed the row (resolvable by subject), or a different principal claimed
				// it first - then this is a fresh identity and gets a fresh row.
				UserTable claimedByUs = userDao.findBySubject(subject);
				if (claimedByUs != null) {
					return claimedByUs;
				}
			}
		}
		try {
			return createUser(subject);
		} catch (PersistenceException e) {
			// A parallel first request of the same user won the unique-constraint
			// race on oidcSubject - use the row it created.
			UserTable existing = userDao.findBySubject(subject);
			if (existing == null) {
				throw e;
			}
			return existing;
		}
	}

	private UserTable createUser(String subject) {
		UserTable created = new UserTable();
		created.setOidcSubject(subject);
		created.setEmail(resolveEmail());
		created.setFirstName(jwt.getClaim(GIVEN_NAME_CLAIM));
		created.setLastName(jwt.getClaim(FAMILY_NAME_CLAIM));
		created.setRole(resolveRole());
		LocalDateTime now = LocalDateTime.now();
		created.setCreatedAt(now);
		created.setModifiedAt(now);
		return userDao.save(created);
	}

	/**
	 * E-mail, names and role are owned by Keycloak: the local row is a read-cache refreshed
	 * from the token claims on every resolve. Absent claims keep the cached value.
	 */
	private UserTable syncProfile(UserTable existing) {
		String email = resolveEmail();
		String firstName = jwt.getClaim(GIVEN_NAME_CLAIM);
		String lastName = jwt.getClaim(FAMILY_NAME_CLAIM);
		Role role = resolveRole();

		boolean changed = false;
		if (email != null && !email.equals(existing.getEmail())) {
			existing.setEmail(email);
			changed = true;
		}
		if (firstName != null && !firstName.equals(existing.getFirstName())) {
			existing.setFirstName(firstName);
			changed = true;
		}
		if (lastName != null && !lastName.equals(existing.getLastName())) {
			existing.setLastName(lastName);
			changed = true;
		}
		if (!Objects.equals(existing.getRole(), role)) {
			existing.setRole(role);
			changed = true;
		}
		if (!changed) {
			return existing;
		}
		existing.setModifiedAt(LocalDateTime.now());
		return userDao.patchUser(existing);
	}

	/**
	 * Redeems pending project invitations for the user's e-mail into memberships (ADR-0003) -
	 * only when the token says the e-mail is verified, so that self-registering someone else's
	 * address (the realm allows login before verification) cannot collect their invitations.
	 */
	private void redeemInvitations(UserTable resolved) {
		if (resolved.getEmail() == null || !isEmailVerified()) {
			return;
		}
		try {
			projectInvitationDao.redeemInvitations(resolved.getId(), resolved.getEmail());
		} catch (PersistenceException e) {
			// Lost a unique-constraint race against a concurrent membership insert
			// (parallel redemption or addContributor). The second pass sees the
			// membership and only removes the invitation.
			try {
				projectInvitationDao.redeemInvitations(resolved.getId(), resolved.getEmail());
			} catch (PersistenceException retryFailed) {
				// Leave the invitations pending; the next request redeems them.
			}
		}
	}

	private String resolveSubject() {
		String subject = jwt.getSubject();
		if (subject == null || subject.isBlank()) {
			throw new NotAuthorizedException("Token does not identify a user", "Bearer");
		}
		return subject;
	}

	private String resolveEmail() {
		return EmailNormalizer.normalize(jwt.getClaim(Claims.email));
	}

	private boolean isEmailVerified() {
		Object verified = jwt.getClaim(Claims.email_verified);
		if (verified instanceof Boolean asBoolean) {
			return asBoolean;
		}
		return JsonValue.TRUE.equals(verified);
	}

	private Role resolveRole() {
		// Realm roles are mapped onto the SecurityIdentity via quarkus.oidc.roles.role-claim-path
		return securityIdentity.getRoles().contains(Role.Admin.name()) ? Role.Admin : Role.User;
	}
}
