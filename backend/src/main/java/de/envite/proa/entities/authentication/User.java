package de.envite.proa.entities.authentication;

import java.time.LocalDateTime;

import lombok.Data;

/**
 * Local profile data of a Keycloak-authenticated user. Read-only in the application:
 * credentials, e-mail and names are owned by Keycloak and synced from the token on every
 * resolve (ADR-0003).
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
