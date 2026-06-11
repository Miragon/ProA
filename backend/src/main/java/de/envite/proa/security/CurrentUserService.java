package de.envite.proa.security;

import java.time.LocalDateTime;

import org.eclipse.microprofile.jwt.Claims;
import org.eclipse.microprofile.jwt.JsonWebToken;

import de.envite.proa.entities.authentication.Role;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.repository.user.UserDao;
import io.quarkus.security.identity.SecurityIdentity;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.transaction.Transactional;
import jakarta.ws.rs.NotAuthorizedException;

/**
 * Resolves the Keycloak-authenticated identity (web mode) to a local {@link UserTable} row.
 *
 * The row is created on the first authenticated request (first login) and the local role is
 * kept in sync with the realm roles carried by the token. Application code consumes
 * {@link #getUserId()} instead of parsing token claims. In desktop mode there is no identity
 * and this service must not be called - the existing app.mode checks in the callers guarantee
 * that.
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

	private UserTable user;

	public Long getUserId() {
		return getUser().getId();
	}

	@Transactional
	public UserTable getUser() {
		if (user == null) {
			user = resolveUser();
		}
		return user;
	}

	private UserTable resolveUser() {
		String email = resolveEmail();
		Role role = resolveRole();

		UserTable existing = userDao.findByEmail(email);
		if (existing == null) {
			return createUser(email, role);
		}
		if (existing.getRole() != role) {
			existing.setRole(role);
			existing.setModifiedAt(LocalDateTime.now());
			existing = userDao.patchUser(existing);
		}
		return existing;
	}

	private UserTable createUser(String email, Role role) {
		UserTable created = new UserTable();
		created.setEmail(email);
		created.setFirstName(jwt.getClaim(GIVEN_NAME_CLAIM));
		created.setLastName(jwt.getClaim(FAMILY_NAME_CLAIM));
		created.setRole(role);
		LocalDateTime now = LocalDateTime.now();
		created.setCreatedAt(now);
		created.setModifiedAt(now);
		return userDao.save(created);
	}

	private String resolveEmail() {
		String email = jwt.getClaim(Claims.email);
		if (email == null || email.isBlank()) {
			// Fall back to the principal name (upn / preferred_username / sub)
			email = jwt.getName();
		}
		if (email == null || email.isBlank()) {
			throw new NotAuthorizedException("Token does not identify a user", "Bearer");
		}
		return email;
	}

	private Role resolveRole() {
		// Realm roles are mapped onto the SecurityIdentity via quarkus.oidc.roles.role-claim-path
		return securityIdentity.getRoles().contains(Role.Admin.name()) ? Role.Admin : Role.User;
	}
}
