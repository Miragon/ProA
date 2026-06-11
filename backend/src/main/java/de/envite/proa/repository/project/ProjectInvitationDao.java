package de.envite.proa.repository.project;

import java.util.List;

import de.envite.proa.repository.tables.ProjectInvitationTable;
import de.envite.proa.repository.tables.ProjectUserRelationTable;
import de.envite.proa.repository.tables.UserTable;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.persistence.LockModeType;
import jakarta.transaction.Transactional;

@ApplicationScoped
public class ProjectInvitationDao {

	@Inject
	EntityManager em;

	@Transactional
	public ProjectInvitationTable persist(ProjectInvitationTable invitation) {
		em.persist(invitation);
		em.flush();
		return invitation;
	}

	@Transactional
	public ProjectInvitationTable findById(Long id) {
		return em.find(ProjectInvitationTable.class, id);
	}

	@Transactional
	public ProjectInvitationTable findByEmailAndProject(String email, Long projectId) {
		return em.createQuery(
						"SELECT i FROM ProjectInvitationTable i WHERE i.email = :email AND i.project.id = :projectId",
						ProjectInvitationTable.class)
				.setParameter("email", email).setParameter("projectId", projectId).getResultStream().findFirst()
				.orElse(null);
	}

	@Transactional
	public List<ProjectInvitationTable> findByProject(Long projectId) {
		return em.createQuery("SELECT i FROM ProjectInvitationTable i WHERE i.project.id = :projectId",
						ProjectInvitationTable.class)
				.setParameter("projectId", projectId).getResultList();
	}

	@Transactional
	public void deleteById(Long id) {
		ProjectInvitationTable invitation = em.find(ProjectInvitationTable.class, id);
		if (invitation != null) {
			em.remove(invitation);
		}
	}

	/**
	 * Redeems all pending invitations for the given (normalized) e-mail into memberships of the
	 * given user and deletes them - atomically.
	 *
	 * Race safety: the invitation rows are read with a PESSIMISTIC_WRITE lock, so two parallel
	 * first requests of the same user serialize here - the loser sees no invitations left and
	 * is a no-op. A membership that already exists (e.g. created concurrently via
	 * addContributor) is skipped; the unique (user, project) constraint on
	 * {@link ProjectUserRelationTable} is the backstop for the remaining write-write window.
	 */
	@Transactional
	public void redeemInvitations(Long userId, String email) {
		List<ProjectInvitationTable> invitations = em.createQuery(
						"SELECT i FROM ProjectInvitationTable i WHERE i.email = :email", ProjectInvitationTable.class)
				.setParameter("email", email).setLockMode(LockModeType.PESSIMISTIC_WRITE).getResultList();

		for (ProjectInvitationTable invitation : invitations) {
			boolean alreadyMember = !em.createQuery(
							"SELECT r.id FROM ProjectUserRelationTable r WHERE r.user.id = :userId AND r.project = :project",
							Long.class)
					.setParameter("userId", userId).setParameter("project", invitation.getProject()).getResultList()
					.isEmpty();

			if (!alreadyMember) {
				ProjectUserRelationTable relation = new ProjectUserRelationTable();
				relation.setUser(em.getReference(UserTable.class, userId));
				relation.setProject(invitation.getProject());
				relation.setRole(invitation.getRole());
				em.persist(relation);
			}
			em.remove(invitation);
		}
	}
}
