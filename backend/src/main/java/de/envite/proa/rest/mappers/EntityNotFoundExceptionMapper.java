package de.envite.proa.rest.mappers;

import java.util.Map;

import jakarta.persistence.EntityNotFoundException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.ExceptionMapper;
import jakarta.ws.rs.ext.Provider;

/**
 * Maps JPA {@link EntityNotFoundException}s (e.g. adding a contributor with an unknown email)
 * to a 404 response.
 */
@Provider
public class EntityNotFoundExceptionMapper implements ExceptionMapper<EntityNotFoundException> {

	@Override
	public Response toResponse(EntityNotFoundException exception) {
		String message = exception.getMessage() != null ? exception.getMessage() : "Not found";
		return Response//
				.status(Response.Status.NOT_FOUND)//
				.entity(Map.of("error", message))//
				.type(MediaType.APPLICATION_JSON)//
				.build();
	}
}
