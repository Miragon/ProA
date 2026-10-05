package de.envite.proa.rest;

import de.envite.proa.entities.process.ProcessConnection;
import de.envite.proa.entities.processmap.ProcessMap;
import de.envite.proa.usecases.processmap.ProcessMapUsecase;
import jakarta.ws.rs.ForbiddenException;
import jakarta.ws.rs.NotFoundException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.*;

public class ProcessMapResourceTest {

	@InjectMocks
	private ProcessMapResource resource;

	@Mock
	private ProcessMapUsecase usecase;

	@Mock
	private ProjectAccessVerifier projectAccessVerifier;

	private static final Long PROJECT_ID = 1L;
	private static final Long CONNECTION_ID = 2L;
	private static final Long CALLING_PROCESS_ID = 3L;
	private static final Long CALLED_PROCESS_ID = 4L;

	@BeforeEach
	public void setUp() {
		MockitoAnnotations.openMocks(this);
	}

	@Test
	public void testGetProcessMap() {
		ProcessMap expectedMap = new ProcessMap();
		when(usecase.getProcessMap(PROJECT_ID)).thenReturn(expectedMap);

		ProcessMap result = resource.getProcessMap(PROJECT_ID);

		assertEquals(expectedMap, result);
		verify(usecase, times(1)).getProcessMap(PROJECT_ID);
		verify(projectAccessVerifier, times(1)).verifyAccessToProjectVersion(PROJECT_ID);
	}

	@Test
	public void testGetProcessMap_NoAccess_Forbidden() {
		doThrow(new ForbiddenException()).when(projectAccessVerifier).verifyAccessToProjectVersion(PROJECT_ID);

		assertThrows(ForbiddenException.class, () -> resource.getProcessMap(PROJECT_ID));

		verifyNoInteractions(usecase);
	}

	@Test
	public void testGetProcessMap_Unknown_NotFound() {
		doThrow(new NotFoundException()).when(projectAccessVerifier).verifyAccessToProjectVersion(PROJECT_ID);

		assertThrows(NotFoundException.class, () -> resource.getProcessMap(PROJECT_ID));

		verifyNoInteractions(usecase);
	}

	@Test
	public void testAddConnection() {
		ProcessConnection connection = new ProcessConnection();
		connection.setCallingProcessid(CALLING_PROCESS_ID);
		connection.setCalledProcessid(CALLED_PROCESS_ID);

		resource.addConnection(PROJECT_ID, connection);

		verify(usecase, times(1)).addConnection(PROJECT_ID, connection);
		verify(projectAccessVerifier, times(1)).verifyAccessToProjectVersion(PROJECT_ID);
		verify(projectAccessVerifier, times(1)).verifyAccessToProcessModel(CALLING_PROCESS_ID);
		verify(projectAccessVerifier, times(1)).verifyAccessToProcessModel(CALLED_PROCESS_ID);
	}

	@Test
	public void testAddConnection_NoAccess_Forbidden() {
		ProcessConnection connection = new ProcessConnection();
		doThrow(new ForbiddenException()).when(projectAccessVerifier).verifyAccessToProjectVersion(PROJECT_ID);

		assertThrows(ForbiddenException.class, () -> resource.addConnection(PROJECT_ID, connection));

		verifyNoInteractions(usecase);
	}

	@Test
	public void testAddConnection_NoAccessToForeignProcess_Forbidden() {
		ProcessConnection connection = new ProcessConnection();
		connection.setCallingProcessid(CALLING_PROCESS_ID);
		connection.setCalledProcessid(CALLED_PROCESS_ID);
		doThrow(new ForbiddenException()).when(projectAccessVerifier).verifyAccessToProcessModel(CALLED_PROCESS_ID);

		assertThrows(ForbiddenException.class, () -> resource.addConnection(PROJECT_ID, connection));

		verifyNoInteractions(usecase);
	}

	@Test
	public void testDeleteProcessConnection() {
		resource.deleteProcessConnection(CONNECTION_ID);

		verify(usecase, times(1)).deleteProcessConnection(CONNECTION_ID);
		verify(projectAccessVerifier, times(1)).verifyAccessToProcessConnection(CONNECTION_ID);
	}

	@Test
	public void testDeleteProcessConnection_NoAccess_Forbidden() {
		doThrow(new ForbiddenException()).when(projectAccessVerifier).verifyAccessToProcessConnection(CONNECTION_ID);

		assertThrows(ForbiddenException.class, () -> resource.deleteProcessConnection(CONNECTION_ID));

		verifyNoInteractions(usecase);
	}

	@Test
	public void testDeleteProcessConnection_Unknown_NotFound() {
		doThrow(new NotFoundException()).when(projectAccessVerifier).verifyAccessToProcessConnection(CONNECTION_ID);

		assertThrows(NotFoundException.class, () -> resource.deleteProcessConnection(CONNECTION_ID));

		verifyNoInteractions(usecase);
	}

	@Test
	public void testDeleteDataStoreConnection() {
		resource.deleteDataStoreConnection(CONNECTION_ID);

		verify(usecase, times(1)).deleteDataStoreConnection(CONNECTION_ID);
		verify(projectAccessVerifier, times(1)).verifyAccessToDataStoreConnection(CONNECTION_ID);
	}

	@Test
	public void testDeleteDataStoreConnection_NoAccess_Forbidden() {
		doThrow(new ForbiddenException()).when(projectAccessVerifier).verifyAccessToDataStoreConnection(CONNECTION_ID);

		assertThrows(ForbiddenException.class, () -> resource.deleteDataStoreConnection(CONNECTION_ID));

		verifyNoInteractions(usecase);
	}

	@Test
	public void testDeleteDataStoreConnection_Unknown_NotFound() {
		doThrow(new NotFoundException()).when(projectAccessVerifier).verifyAccessToDataStoreConnection(CONNECTION_ID);

		assertThrows(NotFoundException.class, () -> resource.deleteDataStoreConnection(CONNECTION_ID));

		verifyNoInteractions(usecase);
	}
}
