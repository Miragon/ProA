package de.envite.proa.entities.authentication;

import java.time.LocalDateTime;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

@Data
public class User {

    /**
     * Validation group for registration. Login is intentionally not validated against these
     * constraints so that the seeded admin account (non-email username, short initial password)
     * can still log in.
     */
    public interface Registration {
    }

    private Long id;
    private String firstName;
    private String lastName;

    @NotBlank(groups = Registration.class)
    @Email(groups = Registration.class)
    private String email;

    @NotBlank(groups = Registration.class)
    @Size(min = 8, groups = Registration.class)
    private String password;

    private LocalDateTime createdAt;
    private LocalDateTime modifiedAt;
    private String role;
}