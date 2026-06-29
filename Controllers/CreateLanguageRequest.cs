using System.ComponentModel.DataAnnotations;

namespace Knowit.Umbraco.AiTranslate.Controllers;

public sealed record CreateLanguageRequest(
    [Required] string IsoCode,
    string? FallbackIsoCode = null);
