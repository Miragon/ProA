package de.envite.proa.repository.project;

import java.util.List;

import de.envite.proa.repository.tables.ProjectTable;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import jakarta.persistence.EntityManager;
import jakarta.transaction.Transactional;

@ApplicationScoped
public class ProjectAccessDao {

	private EntityManager em;

	@Inject
	public ProjectAccessDao(EntityManager em) {
		this.em = em;
	}

	@Transactional
	public boolean existsProject(Long projectId) {
		return em.find(ProjectTable.class, projectId) != null;
	}

	@Transactional
	public boolean isMember(Long userId, Long projectId) {
		Long count = em//
				.createQuery("SELECT COUNT(relation) " //
						+ "FROM ProjectUserRelationTable relation " //
						+ "WHERE relation.project.id = :projectId " //
						+ "AND relation.user.id = :userId", Long.class)//
				.setParameter("projectId", projectId)//
				.setParameter("userId", userId)//
				.getSingleResult();
		return count > 0;
	}

	@Transactional
	public Long findProjectIdForVersion(Long projectVersionId) {
		List<Long> projectIds = em//
				.createQuery("SELECT version.project.id " //
						+ "FROM ProjectVersionTable version " //
						+ "WHERE version.id = :id", Long.class)//
				.setParameter("id", projectVersionId)//
				.getResultList();
		return projectIds.isEmpty() ? null : projectIds.getFirst();
	}

	@Transactional
	public Long findProjectVersionIdForProcessModel(Long processModelId) {
		List<Long> projectVersionIds = em//
				.createQuery("SELECT processModel.project.id " //
						+ "FROM ProcessModelTable processModel " //
						+ "WHERE processModel.id = :id", Long.class)//
				.setParameter("id", processModelId)//
				.getResultList();
		return projectVersionIds.isEmpty() ? null : projectVersionIds.getFirst();
	}

	@Transactional
	public Long findProjectVersionIdForProcessConnection(Long connectionId) {
		List<Long> projectVersionIds = em//
				.createQuery("SELECT connection.project.id " //
						+ "FROM ProcessConnectionTable connection " //
						+ "WHERE connection.id = :id", Long.class)//
				.setParameter("id", connectionId)//
				.getResultList();
		return projectVersionIds.isEmpty() ? null : projectVersionIds.getFirst();
	}

	@Transactional
	public Long findProjectVersionIdForDataStoreConnection(Long connectionId) {
		List<Long> projectVersionIds = em//
				.createQuery("SELECT connection.project.id " //
						+ "FROM DataStoreConnectionTable connection " //
						+ "WHERE connection.id = :id", Long.class)//
				.setParameter("id", connectionId)//
				.getResultList();
		return projectVersionIds.isEmpty() ? null : projectVersionIds.getFirst();
	}
}
