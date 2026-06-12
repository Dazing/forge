var builder = WebApplication.CreateBuilder(args);

// Allow the Vite dev server to call the API during local development.
const string DevCorsPolicy = "dev-web";
builder.Services.AddCors(options =>
    options.AddPolicy(DevCorsPolicy, policy => policy
        .AllowAnyOrigin()
        .AllowAnyHeader()
        .AllowAnyMethod()));

var app = builder.Build();

app.UseCors(DevCorsPolicy);

// Example endpoint. The forge loop grows the API from here.
app.MapGet("/api/health", () => Results.Ok(new HealthResponse("ok")));

app.Run();

public record HealthResponse(string Status);

// Exposed so the test project can spin up the app with WebApplicationFactory.
public partial class Program;
