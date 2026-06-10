package de.envite.proa.rest.mappers;

import de.envite.proa.entities.project.AccessDeniedException;
import de.envite.proa.entities.project.NoResultException;
import de.envite.proa.usecases.processmodel.exceptions.CantReplaceWithCollaborationException;
import jakarta.persistence.EntityNotFoundException;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.NotFoundException;
import jakarta.ws.rs.Path;

/**
 * Test-only resource that throws the exceptions handled by the {@code @Provider} exception
 * mappers so that {@link ExceptionMappersTest} can assert the resulting HTTP responses.
 */
@Path("/test/exception-mappers")
public class ExceptionMapperTestResource {

	static final Long PROCESS_MODEL_ID = 42L;

	@GET
	@Path("/access-denied")
	public String accessDenied() {
		throw new AccessDeniedException("no access to project");
	}

	@GET
	@Path("/no-result")
	public String noResult() {
		throw new NoResultException("project not found");
	}

	@GET
	@Path("/entity-not-found")
	public String entityNotFound() {
		throw new EntityNotFoundException("entity not found");
	}

	@GET
	@Path("/cant-replace-with-collaboration")
	public String cantReplaceWithCollaboration() throws CantReplaceWithCollaborationException {
		throw new CantReplaceWithCollaborationException(PROCESS_MODEL_ID);
	}

	@GET
	@Path("/generic")
	public String generic() {
		throw new IllegalStateException("internal detail that must not leak");
	}

	@GET
	@Path("/web-application")
	public String webApplication() {
		throw new NotFoundException("kept by jax-rs");
	}
}
