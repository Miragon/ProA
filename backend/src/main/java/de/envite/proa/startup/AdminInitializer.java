package de.envite.proa.startup;

import java.util.Set;

import de.envite.proa.entities.authentication.User;
import de.envite.proa.usecases.authentication.AuthenticationUsecase;
import de.envite.proa.usecases.user.UserUsecase;
import io.quarkus.logging.Log;
import io.quarkus.runtime.Startup;
import jakarta.annotation.PostConstruct;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;

import org.eclipse.microprofile.config.inject.ConfigProperty;

@Startup
@ApplicationScoped
public class AdminInitializer {

	private static final Set<String> DEFAULT_ADMIN_PASSWORDS = Set.of("admin", "initial_pw");

	@Inject
	UserUsecase userUsecase;

	@Inject
	AuthenticationUsecase authenticationUsecase;

	@Inject
	@ConfigProperty(name = "admin.email")
	String adminEmail;

	@Inject
	@ConfigProperty(name = "admin.password")
	String adminPassword;

	@Inject
	@ConfigProperty(name = "app.mode", defaultValue = "web")
	String appMode;

	@PostConstruct
	public void init() {
		warnIfDefaultAdminPassword();
		if (userUsecase.findByEmail(adminEmail) != null) {
			return;
		}
		User user = new User();
		user.setEmail(adminEmail);
		user.setPassword(adminPassword);
		user.setRole("Admin");
		try {
			authenticationUsecase.register(user);
		} catch (Exception e) {
			Log.error("Could not register admin user", e);
		}
	}

	private void warnIfDefaultAdminPassword() {
		if ("web".equals(appMode) && DEFAULT_ADMIN_PASSWORDS.contains(adminPassword)) {
			Log.warn("SECURITY WARNING: The admin user is configured with a well-known default password "
					+ "('admin.password'). Change it immediately, the application is running in web mode!");
		}
	}
}
