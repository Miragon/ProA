package de.envite.proa.usecases.project;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.NoResultException;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

/**
 * Verifies that a user is a member (OWNER or COLLABORATEUR) of the project that owns the accessed
 * resource. Used by the REST layer in web mode to prevent IDOR attacks; desktop mode never calls
 * these checks.
 *
 * Id semantics of the project-scoped REST endpoints (verified against the DAOs and JPA entities):
 *
 * - /api/project/{projectId}... (ProjectResource): projectId is a ProjectTable id. These endpoints
 *   already enforce membership/ownership in ProjectRepositoryImpl.
 * - /api/project/{projectId}/process-model... (ProcessModelResource),
 *   /api/project/{projectId}/process-map... (ProcessMapResource) and
 *   /api/camunda-cloud/project/{projectId}/import (CamundaCloudImportResource): despite the name,
 *   "projectId" is a ProjectVersionTable id. ProcessmodelRepositoryImpl and
 *   ProcessMapRepositoryImpl wrap it via new ProjectVersionTable().setId(projectId), and
 *   ProcessModelTable.project is a @ManyToOne to ProjectVersionTable.
 * - /api/process-model/{id}... (ProcessModelResource, incl. {oldProcessId} on replace): id is a
 *   ProcessModelTable id; access is resolved via its project version to the owning ProjectTable.
 * - /api/project/process-map/process-connection/{connectionId}: ProcessConnectionTable id, which
 *   references its ProjectVersionTable in ProcessConnectionTable.project.
 * - /api/project/process-map/datastore-connection/{connectionId}: DataStoreConnectionTable id,
 *   which references its ProjectVersionTable in DataStoreConnectionTable.project.
 * - /api/settings (SettingsResource): settings are user-scoped (SettingsTable references a
 *   UserTable and the resource already passes the JWT userId in web mode), no project check
 *   needed.
 */
@ApplicationScoped
public class ProjectAccessService {

	@Inject
	private ProjectAccessRepository repository;

	public void verifyAccessToProject(Long userId, Long projectId)
			throws AccessDeniedException, NoResultException {
		repository.verifyAccessToProject(userId, projectId);
	}

	public void verifyAccessToProjectVersion(Long userId, Long projectVersionId)
			throws AccessDeniedException, NoResultException {
		repository.verifyAccessToProjectVersion(userId, projectVersionId);
	}

	public void verifyAccessToProcessModel(Long userId, Long processModelId)
			throws AccessDeniedException, NoResultException {
		repository.verifyAccessToProcessModel(userId, processModelId);
	}

	public void verifyAccessToProcessConnection(Long userId, Long connectionId)
			throws AccessDeniedException, NoResultException {
		repository.verifyAccessToProcessConnection(userId, connectionId);
	}

	public void verifyAccessToDataStoreConnection(Long userId, Long connectionId)
			throws AccessDeniedException, NoResultException {
		repository.verifyAccessToDataStoreConnection(userId, connectionId);
	}
}
