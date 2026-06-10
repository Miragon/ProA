package de.envite.proa.rest;

import de.envite.proa.entities.process.ProcessDetails;
import de.envite.proa.entities.process.ProcessInformation;
import de.envite.proa.security.RolesAllowedIfWebVersion;
import de.envite.proa.usecases.processmodel.ProcessModelUsecase;
import de.envite.proa.usecases.processmodel.exceptions.CantReplaceWithCollaborationException;
import jakarta.inject.Inject;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import org.jboss.resteasy.reactive.RestForm;
import org.jboss.resteasy.reactive.RestPath;
import org.jboss.resteasy.reactive.RestResponse;
import org.jboss.resteasy.reactive.RestResponse.ResponseBuilder;

import java.io.File;
import java.util.List;

@Path("/api")
public class ProcessModelResource {

	@Inject
	private ProcessModelUsecase usecase;

	@Inject
	FileService fileService;

	@Inject
	ProjectAccessVerifier projectAccessVerifier;

	/**
	 * Creates a new process model
	 *
	 * @param projectId
	 * 		the id of the project the process model belongs to
	 * @param processModel
	 * 		the bpmn file
	 * @param fileName
	 * 		the file name of the bpmn file
	 * @param description
	 * 		the description of the process
	 * @return id of saved process model
	 */
	@POST
	@Path("/project/{projectId}/process-model")
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public Response uploadProcessModel(@RestPath Long projectId, @RestForm File processModel, @RestForm String fileName,
			@RestForm String description, @RestForm boolean isCollaboration)
			throws CantReplaceWithCollaborationException {
		projectAccessVerifier.verifyAccessToProjectVersion(projectId);
		String content = fileService.readFileToString(processModel);
		if (containsDoctype(content)) {
			return doctypeNotAllowedResponse();
		}
		fileName = fileName.replace(".bpmn", "");
		return Response //
				.ok(usecase.saveProcessModel( //
						projectId, //
						fileName, //
						content, //
						description, //
						isCollaboration //
				)) //
				.build();
	}

	@Path("project/{projectId}/process-model/{oldProcessId}")
	@POST
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public Response replaceProcessModel(@RestPath Long projectId, @RestPath Long oldProcessId,
			@RestForm File processModel,
			@RestForm String fileName, @RestForm String description) throws CantReplaceWithCollaborationException {
		projectAccessVerifier.verifyAccessToProjectVersion(projectId);
		projectAccessVerifier.verifyAccessToProcessModel(oldProcessId);
		String content = fileService.readFileToString(processModel);
		if (containsDoctype(content)) {
			return doctypeNotAllowedResponse();
		}
		fileName = fileName.replace(".bpmn", "");
		Long id = usecase.replaceProcessModel(projectId, oldProcessId, fileName, content, description);
		return Response.ok(id).build();
	}

	/**
	 * BPMN uploads must not contain DOCTYPE declarations. The BPMN parser already rejects them
	 * (XXE protection), this pre-check only turns the rejection into a clear 400 response.
	 */
	private static boolean containsDoctype(String content) {
		return content != null && content.toUpperCase().contains("<!DOCTYPE");
	}

	private static Response doctypeNotAllowedResponse() {
		return Response //
				.status(Response.Status.BAD_REQUEST) //
				.entity("DOCTYPE declarations are not allowed in BPMN files") //
				.build();
	}

	/**
	 * Gets the xml representations of the bpmn file the id corresponds to. This method is called from the process model
	 * view that shows the bpmn via bpmn.io
	 *
	 * @param id
	 * 		of the bpmn file
	 * @return bpmn file as string
	 */
	@Path("/process-model/{id}")
	@GET
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public String getProcessModel(@RestPath Long id) {
		projectAccessVerifier.verifyAccessToProcessModel(id);
		return usecase.getProcessModel(id);
	}

	@Path("/process-model/{id}")
	@DELETE
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public RestResponse<?> deleteProcessModel(@RestPath Long id) {
		projectAccessVerifier.verifyAccessToProcessModel(id);
		usecase.deleteProcessModel(id);
		return ResponseBuilder.ok().build();
	}

	/**
	 * This methods gets the names and the corresponding ids of all process models in order to show them as a list in
	 * the process list in the frontend
	 */
	@GET
	@Path("/project/{projectId}/process-model")
	@Produces(MediaType.APPLICATION_JSON)
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public List<ProcessInformation> getProcessInformation(@RestPath Long projectId) {
		projectAccessVerifier.verifyAccessToProjectVersion(projectId);
		return usecase.getProcessInformation(projectId);
	}

	@GET
	@Path("/process-model/{id}/details")
	@Produces(MediaType.APPLICATION_JSON)
	@RolesAllowedIfWebVersion({ "User", "Admin" })
	public ProcessDetails getProcessDetails(@RestPath Long id) {
		projectAccessVerifier.verifyAccessToProcessModel(id);
		return usecase.getProcessDetails(id);
	}
}