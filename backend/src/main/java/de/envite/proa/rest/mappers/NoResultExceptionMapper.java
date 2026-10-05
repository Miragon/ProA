package de.envite.proa.rest.mappers;

import java.util.Map;

import de.envite.proa.entities.project.NoResultException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.ExceptionMapper;
import jakarta.ws.rs.ext.Provider;

/**
 * Maps the domain {@link NoResultException} to a 404 response so that resources do not have
 * to repeat the try/catch boilerplate.
 */
@Provider
public class NoResultExceptionMapper implements ExceptionMapper<NoResultException> {

	@Override
	public Response toResponse(NoResultException exception) {
		String message = exception.getMessage() != null ? exception.getMessage() : "Not found";
		return Response//
				.status(Response.Status.NOT_FOUND)//
				.entity(Map.of("error", message))//
				.type(MediaType.APPLICATION_JSON)//
				.build();
	}
}
