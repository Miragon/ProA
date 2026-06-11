package de.envite.proa.rest;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.NoResultException;
import de.envite.proa.security.CurrentUserService;
import de.envite.proa.usecases.project.ProjectAccessService;
import jakarta.enterprise.context.RequestScoped;
import jakarta.inject.Inject;
import jakarta.ws.rs.ForbiddenException;
import jakarta.ws.rs.NotFoundException;
import org.eclipse.microprofile.config.inject.ConfigProperty;

/**
 * Enforces project membership for project-scoped REST endpoints in web mode. In desktop mode
 * (single user, no authentication) all checks are skipped so that desktop behavior stays
 * unchanged.
 *
 * Maps AccessDeniedException to 403 (Forbidden) and NoResultException to 404 (Not Found),
 * consistent with the error semantics of ProjectResource.
 */
@RequestScoped
public class ProjectAccessVerifier {

	private static final String WEB_MODE = "web";

	@Inject
	CurrentUserService currentUserService;

	@Inject
	@ConfigProperty(name = "app.mode", defaultValue = "web")
	String appMode;

	@Inject
	ProjectAccessService projectAccessService;

	public void verifyAccessToProjectVersion(Long projectVersionId) {
		if (!isWebMode()) {
			return;
		}
		try {
			projectAccessService.verifyAccessToProjectVersion(getUserId(), projectVersionId);
		} catch (NoResultException e) {
			throw new NotFoundException(e.getMessage());
		} catch (AccessDeniedException e) {
			throw new ForbiddenException(e.getMessage());
		}
	}

	public void verifyAccessToProcessModel(Long processModelId) {
		if (!isWebMode()) {
			return;
		}
		try {
			projectAccessService.verifyAccessToProcessModel(getUserId(), processModelId);
		} catch (NoResultException e) {
			throw new NotFoundException(e.getMessage());
		} catch (AccessDeniedException e) {
			throw new ForbiddenException(e.getMessage());
		}
	}

	public void verifyAccessToProcessConnection(Long connectionId) {
		if (!isWebMode()) {
			return;
		}
		try {
			projectAccessService.verifyAccessToProcessConnection(getUserId(), connectionId);
		} catch (NoResultException e) {
			throw new NotFoundException(e.getMessage());
		} catch (AccessDeniedException e) {
			throw new ForbiddenException(e.getMessage());
		}
	}

	public void verifyAccessToDataStoreConnection(Long connectionId) {
		if (!isWebMode()) {
			return;
		}
		try {
			projectAccessService.verifyAccessToDataStoreConnection(getUserId(), connectionId);
		} catch (NoResultException e) {
			throw new NotFoundException(e.getMessage());
		} catch (AccessDeniedException e) {
			throw new ForbiddenException(e.getMessage());
		}
	}

	private boolean isWebMode() {
		return appMode.equals(WEB_MODE);
	}

	private Long getUserId() {
		return currentUserService.getUserId();
	}
}
