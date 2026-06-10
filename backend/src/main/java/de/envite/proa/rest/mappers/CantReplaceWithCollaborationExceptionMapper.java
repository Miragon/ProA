package de.envite.proa.rest.mappers;

import de.envite.proa.usecases.processmodel.exceptions.CantReplaceWithCollaborationException;
import io.quarkus.logging.Log;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.ExceptionMapper;
import jakarta.ws.rs.ext.Provider;

/**
 * Maps {@link CantReplaceWithCollaborationException} to a 400 response. The exception itself
 * is used as response body because the frontend inspects its {@code exceptionType} property.
 */
@Provider
public class CantReplaceWithCollaborationExceptionMapper
		implements ExceptionMapper<CantReplaceWithCollaborationException> {

	@Override
	public Response toResponse(CantReplaceWithCollaborationException exception) {
		Log.warn("Cannot replace process model with a collaboration", exception);
		return Response//
				.status(Response.Status.BAD_REQUEST)//
				.entity(exception)//
				.type(MediaType.APPLICATION_JSON)//
				.build();
	}
}
