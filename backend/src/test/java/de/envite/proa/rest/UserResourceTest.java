package de.envite.proa.rest;

import de.envite.proa.entities.authentication.User;
import de.envite.proa.security.CurrentUserService;
import de.envite.proa.usecases.user.UserUsecase;
import jakarta.ws.rs.core.Response;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.*;

/**
 * Only the read-only "current user" endpoint remains: user management happens in Keycloak and
 * the admin/self mutation endpoints were removed (ADR-0003).
 */
public class UserResourceTest {

	@InjectMocks
	private UserResource resource;

	@Mock
	private UserUsecase usecase;

	@Mock
	private CurrentUserService currentUserService;

	private static final Long USER_ID = 1L;
	private static final User USER = new User();

	@BeforeEach
	public void setUp() {
		MockitoAnnotations.openMocks(this);
	}

	@Test
	public void testGetUserSuccess() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		when(usecase.findById(USER_ID)).thenReturn(USER);

		Response response = resource.getUser();

		assertEquals(Response.Status.OK.getStatusCode(), response.getStatus());
		assertEquals(USER, response.getEntity());
		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).findById(USER_ID);
	}

	@Test
	public void testGetUserNotFound() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		when(usecase.findById(USER_ID)).thenThrow(new jakarta.ws.rs.NotFoundException());

		Response response = resource.getUser();

		assertEquals(Response.Status.NOT_FOUND.getStatusCode(), response.getStatus());
		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).findById(USER_ID);
	}

	@Test
	public void testGetUserServerError() {
		when(currentUserService.getUserId()).thenReturn(USER_ID);
		when(usecase.findById(USER_ID)).thenThrow(new RuntimeException("Internal Error"));

		Response response = resource.getUser();

		assertEquals(Response.Status.INTERNAL_SERVER_ERROR.getStatusCode(), response.getStatus());
		verify(currentUserService, times(1)).getUserId();
		verify(usecase, times(1)).findById(USER_ID);
	}
}
