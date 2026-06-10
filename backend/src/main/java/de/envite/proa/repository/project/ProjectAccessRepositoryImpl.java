package de.envite.proa.repository.project;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.NoResultException;
import de.envite.proa.usecases.project.ProjectAccessRepository;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

@ApplicationScoped
public class ProjectAccessRepositoryImpl implements ProjectAccessRepository {

	private ProjectAccessDao dao;

	@Inject
	public ProjectAccessRepositoryImpl(ProjectAccessDao dao) {
		this.dao = dao;
	}

	@Override
	public void verifyAccessToProject(Long userId, Long projectId) {
		if (!dao.existsProject(projectId)) {
			throw new NoResultException("Project not found with ID: " + projectId);
		}
		if (!dao.isMember(userId, projectId)) {
			throw new AccessDeniedException("User does not have access to this project.");
		}
	}

	@Override
	public void verifyAccessToProjectVersion(Long userId, Long projectVersionId) {
		Long projectId = dao.findProjectIdForVersion(projectVersionId);
		if (projectId == null) {
			throw new NoResultException("Project version not found with ID: " + projectVersionId);
		}
		verifyAccessToProject(userId, projectId);
	}

	@Override
	public void verifyAccessToProcessModel(Long userId, Long processModelId) {
		Long projectVersionId = dao.findProjectVersionIdForProcessModel(processModelId);
		if (projectVersionId == null) {
			throw new NoResultException("Process model not found with ID: " + processModelId);
		}
		verifyAccessToProjectVersion(userId, projectVersionId);
	}

	@Override
	public void verifyAccessToProcessConnection(Long userId, Long connectionId) {
		Long projectVersionId = dao.findProjectVersionIdForProcessConnection(connectionId);
		if (projectVersionId == null) {
			throw new NoResultException("Process connection not found with ID: " + connectionId);
		}
		verifyAccessToProjectVersion(userId, projectVersionId);
	}

	@Override
	public void verifyAccessToDataStoreConnection(Long userId, Long connectionId) {
		Long projectVersionId = dao.findProjectVersionIdForDataStoreConnection(connectionId);
		if (projectVersionId == null) {
			throw new NoResultException("Data store connection not found with ID: " + connectionId);
		}
		verifyAccessToProjectVersion(userId, projectVersionId);
	}
}
