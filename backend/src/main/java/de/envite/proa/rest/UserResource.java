package de.envite.proa.rest;

import de.envite.proa.entities.authentication.User;
import de.envite.proa.repository.tables.UserTable;
import de.envite.proa.security.CurrentUserService;
import de.envite.proa.usecases.user.UserUsecase;
import jakarta.annotation.security.RolesAllowed;
import jakarta.inject.Inject;
import jakarta.persistence.NoResultException;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
import org.jboss.resteasy.reactive.RestPath;

import java.util.List;
import java.util.Map;

@Path("/api/user")
public class UserResource {

	@Inject
	UserUsecase usecase;

	@Inject
	CurrentUserService currentUserService;

	@PATCH
	@Path("/{id}")
	@RolesAllowed({"Admin"})
	public Response patchUser(@RestPath Long id, User user) {

		User patchedUser = usecase.patchUser(id, user);
		return Response.ok().entity(patchedUser).build();
	}

	@PATCH
	@Path("")
	@RolesAllowed({"User", "Admin"})
	public Response patchUser(User user) {

		UserTable currentUser = currentUserService.getUser();
		if (user.getEmail() != null && !user.getEmail().equals(currentUser.getEmail())) {
			return Response //
					.status(Response.Status.BAD_REQUEST) //
					.entity(Map.of("message", "Email is managed by the identity provider and cannot be changed")) //
					.build();
		}

		User patchedUser = usecase.patchUser(currentUser.getId(), user);
		return Response.ok().entity(patchedUser).build();
	}

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

	@GET
	@Path("/all")
	@RolesAllowed({"Admin"})
	public Response getUsers() {
		try {
			List<User> users = usecase.getAllUsers();
			return Response.ok().entity(users).build();
		} catch (Exception e) {
			return Response.status(Response.Status.INTERNAL_SERVER_ERROR).build();
		}
	}

	@DELETE
	@Path("/{id}")
	@RolesAllowed({"Admin"})
	public Response deleteById(@RestPath Long id) {
		try {
			usecase.deleteById(id);
			return Response.ok().build();
		} catch (NoResultException e) {
			return Response.status(Response.Status.NOT_FOUND).build();
		} catch (Exception e) {return Response.status(Response.Status.INTERNAL_SERVER_ERROR).build();
		}
	}
}
