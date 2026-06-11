package de.envite.proa.rest.mappers;

import java.util.Map;

import org.camunda.bpm.model.xml.ModelParseException;

import io.quarkus.logging.Log;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import jakarta.ws.rs.ext.ExceptionMapper;
import jakarta.ws.rs.ext.Provider;

/**
 * Maps {@link ModelParseException} to a 400 response. The hardened BPMN parser throws it for
 * unparseable uploads and for disallowed constructs such as DOCTYPE declarations (XXE
 * protection). The parser message is logged but deliberately not echoed to the client.
 */
@Provider
public class ModelParseExceptionMapper implements ExceptionMapper<ModelParseException> {

	@Override
	public Response toResponse(ModelParseException exception) {
		Log.warn("Rejected BPMN file that could not be parsed", exception);
		return Response//
				.status(Response.Status.BAD_REQUEST)//
				.entity(Map.of("error", "Invalid BPMN file"))//
				.type(MediaType.APPLICATION_JSON)//
				.build();
	}
}
