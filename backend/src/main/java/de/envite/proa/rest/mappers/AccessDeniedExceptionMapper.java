package de.envite.proa.rest.mappers;

import java.util.Map;

import de.envite.proa.entities.project.AccessDeniedException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.ExceptionMapper;
import jakarta.ws.rs.ext.Provider;

/**
 * Maps the domain {@link AccessDeniedException} to a 403 response so that resources do not
 * have to repeat the try/catch boilerplate.
 */
@Provider
public class AccessDeniedExceptionMapper implements ExceptionMapper<AccessDeniedException> {

	@Override
	public Response toResponse(AccessDeniedException exception) {
		String message = exception.getMessage() != null ? exception.getMessage() : "Access forbidden";
		return Response//
				.status(Response.Status.FORBIDDEN)//
				.entity(Map.of("error", message))//
				.type(MediaType.APPLICATION_JSON)//
				.build();
	}
}
