package de.envite.proa.repository.user;

import de.envite.proa.repository.tables.UserTable;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.persistence.NoResultException;
import jakarta.transaction.Transactional;

@ApplicationScoped
public class UserDao {

	@Inject
	EntityManager em;

	@Transactional
	public UserTable findBySubject(String oidcSubject) {
		try {
			return em.createQuery("SELECT u FROM UserTable u WHERE u.oidcSubject = :oidcSubject", UserTable.class)
					.setParameter("oidcSubject", oidcSubject).getSingleResult();
		} catch (NoResultException e) {
			return null;
		}
	}

	/**
	 * E-mail is profile data and not unique: after an e-mail address has been recycled it may
	 * exist on a stale legacy row and on the current owner's row. The newest row (highest id)
	 * is the live identity.
	 */
	@Transactional
	public UserTable findByEmail(String email) {
		return em.createQuery("SELECT u FROM UserTable u WHERE u.email = :email ORDER BY u.id DESC", UserTable.class)
				.setParameter("email", email).setMaxResults(1).getResultStream().findFirst().orElse(null);
	}

	/**
	 * Finds a row that predates the subject binding (oidcSubject is null) for the one-time
	 * migration in CurrentUserService. At most one such row per e-mail can exist because the
	 * e-mail column was unique while these rows were created.
	 */
	@Transactional
	public UserTable findLegacyByEmail(String email) {
		return em.createQuery("SELECT u FROM UserTable u WHERE u.email = :email AND u.oidcSubject IS NULL",
						UserTable.class)
				.setParameter("email", email).getResultStream().findFirst().orElse(null);
	}

	/**
	 * Backfills the OIDC subject on a legacy row - exactly once: the guarded UPDATE only
	 * succeeds while the subject is still null, so concurrent claims (or a claim against a row
	 * that meanwhile belongs to another principal) lose deterministically.
	 *
	 * @return whether this call won the claim
	 */
	@Transactional
	public boolean claimSubject(Long userId, String oidcSubject) {
		return em.createQuery(
						"UPDATE UserTable u SET u.oidcSubject = :oidcSubject WHERE u.id = :userId AND u.oidcSubject IS NULL")
				.setParameter("oidcSubject", oidcSubject).setParameter("userId", userId).executeUpdate() == 1;
	}

	@Transactional
	public UserTable findById(Long id) {
		return em.find(UserTable.class, id);
	}

	@Transactional
	public UserTable save(UserTable user) {
		em.persist(user);
		em.flush();
		return user;
	}

	@Transactional
	public UserTable patchUser(UserTable user) {
		return em.merge(user);
	}
}
