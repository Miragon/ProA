package de.envite.proa.usecases.project;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.NoResultException;

public interface ProjectAccessRepository {

	void verifyAccessToProject(Long userId, Long projectId) throws AccessDeniedException, NoResultException;

	void verifyAccessToProjectVersion(Long userId, Long projectVersionId)
			throws AccessDeniedException, NoResultException;

	void verifyAccessToProcessModel(Long userId, Long processModelId) throws AccessDeniedException, NoResultException;

	void verifyAccessToProcessConnection(Long userId, Long connectionId)
			throws AccessDeniedException, NoResultException;

	void verifyAccessToDataStoreConnection(Long userId, Long connectionId)
			throws AccessDeniedException, NoResultException;
}
