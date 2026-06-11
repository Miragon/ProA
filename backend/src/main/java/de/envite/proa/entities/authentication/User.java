package de.envite.proa.entities.authentication;

import java.time.LocalDateTime;

import lombok.Data;

/**
 * Local profile data of a Keycloak-authenticated user. Credentials and e-mail are owned by
 * Keycloak; only firstName/lastName are editable through the application.
 */
@Data
public class User {

    private Long id;
    private String firstName;
    private String lastName;
    private String email;
    private LocalDateTime createdAt;
    private LocalDateTime modifiedAt;
    private String role;
}
