
package de.envite.proa.rest;

import de.envite.proa.entities.settings.Settings;
import de.envite.proa.security.CurrentUserService;
import de.envite.proa.security.RolesAllowedIfWebVersion;
import de.envite.proa.usecases.settings.SettingsUsecase;
import jakarta.ws.rs.*;
import jakarta.inject.Inject;
import jakarta.ws.rs.core.MediaType;
import org.eclipse.microprofile.config.inject.ConfigProperty;

@Path("/api/settings")
public class SettingsResource {

	@Inject
	SettingsUsecase usecase;

	@Inject
	CurrentUserService currentUserService;

	@Inject
	@ConfigProperty(name = "app.mode", defaultValue = "web")
	String appMode;

	@GET
	@Path("")
	@Produces(MediaType.APPLICATION_JSON)
	@RolesAllowedIfWebVersion({"User", "Admin"})
	public Settings getSettings() {
		if (appMode.equals("web")) {
			return usecase.getSettings(currentUserService.getUserId());
		}
		return usecase.getSettings();
	}

	@POST
	@Path("")
	@Consumes(MediaType.APPLICATION_JSON)
	@Produces(MediaType.APPLICATION_JSON)
	@RolesAllowedIfWebVersion({"User", "Admin"})
	public Settings createSettings(Settings settings) {
		if (appMode.equals("web")) {
			return usecase.createSettings(currentUserService.getUserId(), settings);
		}
		return usecase.createSettings(settings);
	}

	@PATCH
	@Path("")
	@Consumes(MediaType.APPLICATION_JSON)
	@Produces(MediaType.APPLICATION_JSON)
	@RolesAllowedIfWebVersion({"User", "Admin"})
	public Settings updateSettings(Settings settings) {
		if (appMode.equals("web")) {
			return usecase.updateSettings(currentUserService.getUserId(), settings);
		}
		return usecase.updateSettings(settings);
	}
}
