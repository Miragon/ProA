package de.envite.proa.rest;

import de.envite.proa.entities.authentication.User;
import de.envite.proa.security.CurrentUserService;
import de.envite.proa.usecases.user.UserUsecase;
import jakarta.annotation.security.RolesAllowed;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.NotFoundException;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.core.Response;

/**
 * Read-only view of the currently logged-in user. User lifecycle and profile data are owned by
 * Keycloak (account console / admin console); the local row is a read-cache synced from the
 * token on every resolve (ADR-0003).
 */
@Path("/api/user")
public class UserResource {

	@Inject
	UserUsecase usecase;

	@Inject
	CurrentUserService currentUserService;

	@GET
	@Path("")
	@RolesAllowed({"User", "Admin"})
	public Response getUser() {
		Long id = currentUserService.getUserId();
		try {
			User user = usecase.findById(id);
			return Response.ok().entity(user).build();
		} catch (NotFoundException e) {
			return Response.status(Response.Status.NOT_FOUND).build();
		} catch (Exception e) {
			return Response.status(Response.Status.INTERNAL_SERVER_ERROR).build();
		}
	}
}
