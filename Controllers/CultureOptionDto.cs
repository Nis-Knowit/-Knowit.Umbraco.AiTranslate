namespace Knowit.Umbraco.AiTranslate.Controllers;

public sealed record CultureOptionDto(
    string IsoCode,
    string EnglishName,
    string NativeName);
