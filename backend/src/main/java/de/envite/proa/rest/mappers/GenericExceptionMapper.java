package de.envite.proa.rest.mappers;

import java.util.Map;

import io.quarkus.logging.Log;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.ExceptionMapper;
import jakarta.ws.rs.ext.Provider;

/**
 * Safety net for unexpected exceptions: logs the error and returns a 500 response without
 * leaking internals. {@link WebApplicationException}s keep their own response.
 */
@Provider
public class GenericExceptionMapper implements ExceptionMapper<Exception> {

	@Override
	public Response toResponse(Exception exception) {
		if (exception instanceof WebApplicationException webApplicationException) {
			return webApplicationException.getResponse();
		}
		Log.error("Unhandled exception while processing request", exception);
		return Response//
				.status(Response.Status.INTERNAL_SERVER_ERROR)//
				.entity(Map.of("error", "Internal server error"))//
				.type(MediaType.APPLICATION_JSON)//
				.build();
	}
}
